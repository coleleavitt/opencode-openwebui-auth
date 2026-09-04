import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    AUTH_RETRY_STATUSES,
    backoffDelayMs,
    carriedNoContent,
    formatStreamDiagnostics,
    isTokenExpired,
    isTransientNetworkError,
    log,
    logDebugArtifact,
    logRequest,
    logResponse,
    logStream,
    MAX_RETRY_AFTER_MS,
    maxRetries,
    newStreamDiagnostics,
    type OpenWebUIAccount,
    oidcLogin,
    parseRetryAfterMs,
    parseUsageFromBuffer,
    RATE_LIMIT_STATUS,
    RETRY_BASE_MS,
    RETRY_STATUSES,
    RETRYABLE_BODY_PATTERNS,
    reachedTerminalFrame,
    recordChunkContent,
    refreshSkewMs,
    type Storage,
    scanSseText,
    shapeBedrockRequestBody,
    truncateForLog,
} from "@openwebui-auth/core";

const BODY_LOG_DIR = join(
    homedir(),
    ".config",
    "opencode",
    "openwebui-auth",
    "logs",
);
const RES_LOG = join(BODY_LOG_DIR, "responses.log");
const SUMMARY_LOG = join(BODY_LOG_DIR, "summary.log");
try {
    mkdirSync(BODY_LOG_DIR, { recursive: true, mode: 0o700 });
} catch {}

const VERBOSE_BODY_LOG = process.env.OPENWEBUI_AUTH_DEBUG === "verbose";

function bodyLog(path: string, entry: Record<string, unknown>): void {
    try {
        const isNew = !existsSync(path);
        appendFileSync(
            path,
            `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
        );
        if (isNew) chmodSync(path, 0o600);
    } catch {}
}

// Retry policy, Retry-After parsing, and Bedrock-mislabel detection are shared
// with the pi adapter — see @openwebui-auth/core/retry-policy.
const STREAM_TIMEOUT_S = 600;
const SAFETY_TIMEOUT_MS = 10 * 60 * 1000;

const OWUI_SENSITIVE_HEADERS = new Set([
    "x-api-key",
    "anthropic-version",
    "anthropic-beta",
]);

// Bedrock request-shaping and Retry-After parsing live in core; re-exported here
// so existing imports and tests that reference them via ./fetch keep working.
export {
    parseRetryAfterMs,
    sanitizeBedrockContent,
    sanitizeContentBlock,
    sanitizeMessageContent,
} from "@openwebui-auth/core";

function rewriteBody(
    init: RequestInit | undefined,
    url: string,
): { init: RequestInit | undefined; original: unknown; rewritten: unknown } {
    if (!init?.body || typeof init.body !== "string") {
        return { init, original: null, rewritten: null };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(init.body);
    } catch {
        return { init, original: null, rewritten: null };
    }
    const original = JSON.parse(JSON.stringify(parsed));
    const scrubbed = shapeBedrockRequestBody(parsed as Record<string, unknown>);

    const obj = scrubbed as Record<string, unknown>;
    if (obj.stream === true) {
        obj.stream_options = {
            ...((obj.stream_options as Record<string, unknown>) || {}),
            include_usage: true,
        };
    }
    if (VERBOSE_BODY_LOG) {
        bodyLog(join(BODY_LOG_DIR, "requests.log"), {
            url,
            original,
            scrubbed,
        });
    }
    bodyLog(SUMMARY_LOG, {
        url,
        model: (scrubbed as Record<string, unknown>).model,
        stream: (scrubbed as Record<string, unknown>).stream,
        msgs: Array.isArray((scrubbed as Record<string, unknown>).messages)
            ? ((scrubbed as Record<string, unknown>).messages as unknown[])
                  .length
            : 0,
        tools: Array.isArray((scrubbed as Record<string, unknown>).tools)
            ? ((scrubbed as Record<string, unknown>).tools as unknown[]).length
            : 0,
        tool_choice:
            (scrubbed as Record<string, unknown>).tool_choice ?? "<absent>",
        orig_tools: Array.isArray((original as Record<string, unknown>).tools)
            ? ((original as Record<string, unknown>).tools as unknown[]).length
            : 0,
        orig_tool_choice:
            (original as Record<string, unknown>).tool_choice ?? "<absent>",
    });
    return {
        init: { ...init, body: JSON.stringify(scrubbed) },
        original,
        rewritten: scrubbed,
    };
}

function buildHeaders(
    init: RequestInit | undefined,
    account: OpenWebUIAccount,
    isStreaming: boolean,
): Headers {
    const headers = new Headers();
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            for (const [key, value] of init.headers) headers.set(key, value);
        } else if (Array.isArray(init.headers)) {
            for (const [key, value] of init.headers) {
                if (value !== undefined) headers.set(key, String(value));
            }
        } else {
            for (const [key, value] of Object.entries(init.headers)) {
                if (value !== undefined) headers.set(key, String(value));
            }
        }
    }
    for (const name of OWUI_SENSITIVE_HEADERS) headers.delete(name);
    headers.set("authorization", `Bearer ${account.token}`);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set(
        "content-type",
        headers.get("content-type") ?? "application/json",
    );
    headers.set("connection", "keep-alive");
    if (isStreaming) {
        headers.set("x-litellm-stream-timeout", String(STREAM_TIMEOUT_S));
        headers.set("x-litellm-timeout", String(STREAM_TIMEOUT_S));
    }
    return headers;
}

function rewriteUrl(input: string | URL | Request, baseUrl: string): URL {
    const raw =
        input instanceof URL
            ? input
            : new URL(typeof input === "string" ? input : input.url);

    const target = new URL(baseUrl);

    if (raw.pathname.includes("/chat/completions")) {
        target.pathname = "/api/chat/completions";
    } else if (raw.pathname.includes("/models")) {
        target.pathname = "/api/models";
    } else {
        target.pathname = raw.pathname;
    }
    target.search = raw.search;
    return target;
}

function interceptUsage(
    res: Response,
    storage: Storage,
    accountName: string,
    modelId: string | undefined,
): Response {
    if (!res.body) return res;

    const [userStream, usageStream] = res.body.tee();
    const abortController = new AbortController();

    const userReader = userStream.getReader();
    const wrappedUserStream = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await userReader.read();
                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            } catch (e) {
                controller.error(e);
            }
        },
        cancel() {
            userReader.releaseLock();
            abortController.abort();
        },
    });

    (async () => {
        const reader = usageStream.getReader();
        const diag = newStreamDiagnostics();
        const started = Date.now();
        let carry = "";
        let rawTail = "";
        try {
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                if (abortController.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value as Uint8Array | undefined, {
                    stream: true,
                });
                diag.bytes += value?.byteLength ?? 0;
                carry = scanSseText(diag, text, carry, (chunk) =>
                    recordChunkContent(diag, chunk),
                );
                buffer += text;
                if (buffer.length > 4096) {
                    buffer = buffer.slice(-4096);
                }
                rawTail += text;
                if (rawTail.length > 16384) rawTail = rawTail.slice(-16384);
            }

            if (carry.trim().length > 0) scanSseText(diag, "\n", carry);
            const usage = parseUsageFromBuffer(buffer);
            if (usage) {
                log(
                    `[usage] ${accountName} model=${modelId ?? "unknown"}: in=${usage.input} out=${usage.output} cache_read=${usage.cacheRead}`,
                );
                await storage.addUsage(accountName, {
                    ...usage,
                    model: modelId,
                });
            }
            // opencode parses the stream itself; this side only records what
            // the proxy sent so an error frame, a truncated body or an empty
            // completion is visible in the log instead of vanishing.
            const suspicious =
                diag.firstError !== undefined ||
                !reachedTerminalFrame(diag) ||
                carriedNoContent(diag);
            logStream(
                "opencode",
                `model=${modelId ?? "unknown"} ms=${Date.now() - started} outcome=${
                    diag.firstError
                        ? "error-frame"
                        : !reachedTerminalFrame(diag)
                          ? "truncated"
                          : carriedNoContent(diag)
                            ? "empty"
                            : "ok"
                } ${formatStreamDiagnostics(diag)}`,
            );
            if (suspicious) {
                logDebugArtifact(
                    "opencode-stream-failures",
                    `model=${modelId ?? "unknown"} ${formatStreamDiagnostics(diag)}`,
                    rawTail,
                );
            }
        } catch {
            // Usage tracking is best-effort
        } finally {
            reader.releaseLock();
            try {
                await usageStream.cancel();
            } catch {}
        }
    })().catch((e) => log(`[usage-extract] failed: ${e?.message ?? e}`));

    return new Response(wrappedUserStream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    });
}

async function peekText(res: Response): Promise<string> {
    try {
        return (await res.clone().text()).slice(0, 500);
    } catch {
        return "";
    }
}

export function makeOwuiFetch(storage: Storage) {
    return async function owuiFetch(
        input: string | URL | Request,
        init?: RequestInit,
    ): Promise<Response> {
        let account = storage.getCurrent();
        if (!account) {
            throw new Error(
                "No OpenWebUI account configured. Run: opencode auth login openwebui",
            );
        }
        if (account.disabled) {
            throw new Error(`Account ${account.name} is disabled`);
        }
        if (isTokenExpired(account.token, refreshSkewMs())) {
            const expired = isTokenExpired(account.token, 0);
            log(
                `[fetch] token ${expired ? "expired" : "near expiry"} for ${account.name} — attempting proactive refresh`,
            );
            const username = process.env.OWUI_USERNAME;
            const password = process.env.OWUI_PASSWORD;
            if (username && password) {
                try {
                    const result = await oidcLogin({
                        baseUrl: account.baseUrl,
                        username,
                        password,
                        duoPasscode: process.env.OWUI_DUO_PASSCODE,
                        duoMethod: process.env.OWUI_DUO_PASSCODE
                            ? "passcode"
                            : "push",
                    });
                    account = {
                        ...account,
                        token: result.token,
                        expiresAt: result.expiresAt,
                        updatedAt: Date.now(),
                    };
                    await storage.upsert(account);
                    log(
                        `[fetch] auto-refreshed token for ${account.name}, expires ${new Date(result.expiresAt).toISOString()}`,
                    );
                } catch (err) {
                    log(
                        `[fetch] auto-refresh failed: ${err instanceof Error ? err.message : err}`,
                    );
                    throw new Error(
                        `Token for ${account.name} is expired and auto-refresh failed. Re-run: bun src/cli.ts login`,
                    );
                }
            } else {
                throw new Error(
                    `Token for ${account.name} is expired. Set OWUI_USERNAME+OWUI_PASSWORD for auto-refresh, or re-run: bun src/cli.ts login`,
                );
            }
        }

        const url = rewriteUrl(input, account.baseUrl);
        const { init: rewritten, rewritten: parsedBody } = rewriteBody(
            init,
            url.toString(),
        );

        const isChatCompletions = url.pathname.includes("/chat/completions");
        const accountForUsage = account.name;
        let requestModelId: string | undefined;
        if (parsedBody && typeof parsedBody === "object") {
            const m = (parsedBody as Record<string, unknown>).model;
            if (typeof m === "string") requestModelId = m;
        }

        const isStreaming = Boolean(
            rewritten?.body &&
                typeof rewritten.body === "string" &&
                rewritten.body.includes('"stream":true'),
        );
        const headers = buildHeaders(init, account, isStreaming);

        const incomingSignal = rewritten?.signal as AbortSignal | undefined;
        const safetySignal = AbortSignal.timeout(SAFETY_TIMEOUT_MS);
        const signals: AbortSignal[] = [safetySignal];
        if (incomingSignal) signals.push(incomingSignal);
        const combinedSignal =
            signals.length === 1 ? signals[0] : AbortSignal.any(signals);

        const fetchOpts: RequestInit = {
            ...rewritten,
            headers,
            signal: combinedSignal,
        };

        let lastRes: Response | undefined;
        let didAuthRetry = false;
        // When a 429 carries a Retry-After, the next iteration waits exactly that
        // long instead of the generic exponential backoff.
        let pendingDelayMs: number | undefined;
        const retryBudget = maxRetries();
        let networkFailures = 0;
        for (let attempt = 0; attempt <= retryBudget; attempt++) {
            if (attempt > 0) {
                const delay =
                    pendingDelayMs ??
                    RETRY_BASE_MS *
                        2 ** (attempt - 1) *
                        (0.5 + Math.random() * 0.5);
                pendingDelayMs = undefined;
                log(
                    `[fetch] retry #${attempt} in ${Math.round(delay)}ms after ${lastRes?.status ?? "?"}...`,
                );
                await new Promise((r) => setTimeout(r, delay));
            }

            logRequest(url.toString(), init?.method ?? "GET");
            let res: Response;
            try {
                res = await fetch(url, fetchOpts);
            } catch (err) {
                if (
                    !isTransientNetworkError(err) ||
                    networkFailures >= retryBudget ||
                    combinedSignal.aborted
                ) {
                    throw err;
                }
                networkFailures++;
                const delay = backoffDelayMs(networkFailures);
                logStream(
                    "opencode",
                    `model=${requestModelId ?? "unknown"} outcome=network-error retry_in_ms=${Math.round(delay)} err="${truncateForLog(err instanceof Error ? err.message : String(err))}"`,
                );
                await new Promise((r) => setTimeout(r, delay));
                attempt--; // transport failures have their own budget
                continue;
            }
            logResponse(url.toString(), res.status);
            lastRes = res;

            if (res.ok) {
                // A 200 that is not JSON/SSE is the SPA (wrong host or a
                // session redirect). Fail closed: opencode would otherwise
                // parse nothing and settle an empty assistant turn.
                const contentType = (
                    res.headers.get("content-type") ?? ""
                ).toLowerCase();
                if (
                    isChatCompletions &&
                    !contentType.includes("application/json") &&
                    !contentType.includes("text/event-stream") &&
                    !contentType.includes("application/x-ndjson")
                ) {
                    const sample = await peekText(res);
                    logStream(
                        "opencode",
                        `model=${requestModelId ?? "unknown"} outcome=unexpected-content-type status=${res.status} ct=${contentType || "none"} sample="${truncateForLog(sample, 160)}"`,
                    );
                    return new Response(
                        JSON.stringify({
                            error: {
                                message: `OpenWebUI returned ${contentType || "an unknown content type"} instead of a completion (HTML page: wrong host or expired session?)`,
                                type: "proxy_error",
                                code: 502,
                            },
                        }),
                        {
                            status: 502,
                            headers: { "Content-Type": "application/json" },
                        },
                    );
                }
                if (isChatCompletions && res.body && accountForUsage) {
                    return interceptUsage(
                        res,
                        storage,
                        accountForUsage,
                        requestModelId,
                    );
                }
                return res;
            }

            if (AUTH_RETRY_STATUSES.has(res.status) && !didAuthRetry) {
                didAuthRetry = true;
                const username = process.env.OWUI_USERNAME;
                const password = process.env.OWUI_PASSWORD;
                if (username && password) {
                    log(`[fetch] got ${res.status} — attempting token refresh`);
                    await res.text().catch(() => {});
                    try {
                        const result = await oidcLogin({
                            baseUrl: account.baseUrl,
                            username,
                            password,
                            duoPasscode: process.env.OWUI_DUO_PASSCODE,
                            duoMethod: process.env.OWUI_DUO_PASSCODE
                                ? "passcode"
                                : "push",
                        });
                        account = {
                            ...account,
                            token: result.token,
                            expiresAt: result.expiresAt,
                            updatedAt: Date.now(),
                        };
                        await storage.upsert(account);
                        headers.set("authorization", `Bearer ${account.token}`);
                        log(
                            `[fetch] refreshed token for ${account.name} after ${res.status}`,
                        );
                        attempt--;
                        continue;
                    } catch (err) {
                        log(
                            `[fetch] auth refresh failed: ${err instanceof Error ? err.message : err}`,
                        );
                    }
                }
            }

            // Rate limited (429). The instance's rate_limit_inlet_filter and the
            // upstream provider both emit this; honor Retry-After when present,
            // clamped to MAX_RETRY_AFTER_MS, otherwise fall through to backoff.
            if (res.status === RATE_LIMIT_STATUS && attempt < retryBudget) {
                const retryAfter = parseRetryAfterMs(res);
                pendingDelayMs =
                    retryAfter !== undefined
                        ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
                        : undefined;
                log(
                    `[fetch] 429 rate limited — ${
                        pendingDelayMs !== undefined
                            ? `Retry-After ${Math.round(pendingDelayMs)}ms`
                            : "no Retry-After, using backoff"
                    }`,
                );
                try {
                    const text = await res.text();
                    bodyLog(RES_LOG, {
                        url: url.toString(),
                        status: res.status,
                        body: text.slice(0, 500),
                        retryAfterMs: pendingDelayMs ?? null,
                        attempt,
                    });
                } catch {}
                continue;
            }

            const xShouldRetry = res.headers.get("x-should-retry");
            const shouldRetry =
                xShouldRetry === "true" ||
                (xShouldRetry !== "false" && RETRY_STATUSES.has(res.status));

            if (shouldRetry && attempt < retryBudget) {
                try {
                    const text = await res.text();
                    bodyLog(RES_LOG, {
                        url: url.toString(),
                        status: res.status,
                        body: text.slice(0, 500),
                        attempt,
                    });
                } catch {}
                continue;
            }

            // Detect Bedrock transient errors misclassified as 400 by LiteLLM.
            // See RETRYABLE_BODY_PATTERNS for details on the upstream bug.
            if (
                res.status === 400 &&
                attempt < retryBudget &&
                isChatCompletions
            ) {
                try {
                    const text = await res.text();
                    const isRetryable = RETRYABLE_BODY_PATTERNS.some((p) =>
                        text.includes(p),
                    );
                    if (isRetryable) {
                        log(
                            `[fetch] detected misclassified Bedrock 503 as 400 — retrying (attempt ${attempt})`,
                        );
                        bodyLog(RES_LOG, {
                            url: url.toString(),
                            status: res.status,
                            body: text.slice(0, 500),
                            retryable: true,
                            attempt,
                        });
                        continue;
                    }
                    // Not retryable — reconstruct since body was consumed
                    const rebuilt = new Response(text, {
                        status: res.status,
                        statusText: res.statusText,
                        headers: res.headers,
                    });
                    bodyLog(RES_LOG, {
                        url: url.toString(),
                        status: res.status,
                        body: text.slice(0, 2000),
                    });
                    return rebuilt;
                } catch {}
            }

            if (!res.ok) {
                try {
                    const clone = res.clone();
                    const text = await clone.text();
                    bodyLog(RES_LOG, {
                        url: url.toString(),
                        status: res.status,
                        body: text.slice(0, 2000),
                    });

                    if (text.includes("<html") || text.includes("<!DOCTYPE")) {
                        const errorJson = JSON.stringify({
                            error: {
                                message: `Upstream error ${res.status} (nginx/proxy)`,
                                type: "proxy_error",
                                code: res.status,
                            },
                        });
                        return new Response(errorJson, {
                            status: res.status,
                            headers: { "Content-Type": "application/json" },
                        });
                    }
                } catch {}
            }
            return res;
        }
        // Every iteration assigns lastRes before it can continue, and the loop
        // always runs at least once, so this is unreachable — but throwing beats
        // asserting: if the loop is ever restructured, this fails loudly instead
        // of returning undefined as a Response.
        if (!lastRes) throw new Error("retry loop exited without a response");
        return lastRes;
    };
}
