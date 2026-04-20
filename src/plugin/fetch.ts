import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isTokenExpired } from "../oauth/jwt";
import { oidcLogin } from "../oauth/oidc-login";
import { log, logRequest, logResponse } from "../logger";
import type { Storage } from "../storage";
import type { OpenWebUIAccount } from "../types";

const BODY_LOG_DIR = join(homedir(), ".config", "opencode", "openwebui-auth", "logs");
const RES_LOG = join(BODY_LOG_DIR, "responses.log");
const SUMMARY_LOG = join(BODY_LOG_DIR, "summary.log");
try {
    mkdirSync(BODY_LOG_DIR, { recursive: true, mode: 0o700 });
} catch {}

const VERBOSE_BODY_LOG = process.env.OPENWEBUI_AUTH_DEBUG === "verbose";

function bodyLog(path: string, entry: Record<string, unknown>): void {
    try {
        const isNew = !existsSync(path);
        appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
        if (isNew) chmodSync(path, 0o600);
    } catch {}
}

const RETRY_STATUSES = new Set([502, 503, 504]);
const AUTH_RETRY_STATUSES = new Set([401, 403]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1500;
const STREAM_TIMEOUT_S = 600;
const SAFETY_TIMEOUT_MS = 10 * 60 * 1000;

const OWUI_SENSITIVE_HEADERS = new Set(["x-api-key", "anthropic-version", "anthropic-beta"]);

const DUMMY_TOOL = {
    type: "function",
    function: {
        name: "dummy_tool",
        description: "placeholder tool — never call",
        parameters: { type: "object", properties: {} },
    },
};

function messagesReferenceTools(messages: unknown): boolean {
    if (!Array.isArray(messages)) return false;
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        if (m.role === "tool") return true;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
        if (m.tool_call_id) return true;
    }
    return false;
}

function scrubBedrockToolFields(body: unknown): unknown {
    if (!body || typeof body !== "object") return body;
    const obj = body as Record<string, unknown>;
    const tools = obj.tools;
    const hasTools = Array.isArray(tools) && tools.length > 0;

    if (!hasTools) {
        if ("tools" in obj) delete obj.tools;
        if ("tool_choice" in obj) delete obj.tool_choice;
        if ("parallel_tool_calls" in obj) delete obj.parallel_tool_calls;

        // LiteLLM+Bedrock also rejects if the *conversation history* contains
        // tool calls or tool-role messages, even when the request declares no
        // tools. Equivalent of litellm_settings::modify_params=True: inject a
        // dummy tool so validation passes. The model never calls it.
        if (messagesReferenceTools(obj.messages)) {
            obj.tools = [DUMMY_TOOL];
        }
    } else {
        const choice = obj.tool_choice;
        const choiceType =
            typeof choice === "object" && choice !== null
                ? (choice as { type?: string }).type
                : typeof choice === "string"
                  ? choice
                  : undefined;

        if (choiceType === "none") {
            // Bedrock does not support tool_choice:"none" — drop tools for
            // this turn so the model just generates free text.
            delete obj.tools;
            delete obj.tool_choice;
            delete obj.parallel_tool_calls;
        } else if (choiceType === "any" || choiceType === "required") {
            // Bedrock supports "auto" and specific tool choice; coerce
            // "any"/"required" to "auto" (closest semantic equivalent).
            obj.tool_choice = "auto";
        }
    }

    // Old-style OpenAI function-calling API — Bedrock chokes on these
    if ("functions" in obj) delete obj.functions;
    if ("function_call" in obj) delete obj.function_call;
    return obj;
}

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
    const scrubbed = scrubBedrockToolFields(parsed);

    const obj = scrubbed as Record<string, unknown>;
    if (obj.stream === true) {
        obj.stream_options = { ...(obj.stream_options as Record<string, unknown> || {}), include_usage: true };
    }
    if (VERBOSE_BODY_LOG) {
        bodyLog(join(BODY_LOG_DIR, "requests.log"), { url, original, scrubbed });
    }
    bodyLog(SUMMARY_LOG, {
        url,
        model: (scrubbed as Record<string, unknown>).model,
        stream: (scrubbed as Record<string, unknown>).stream,
        msgs: Array.isArray((scrubbed as Record<string, unknown>).messages)
            ? ((scrubbed as Record<string, unknown>).messages as unknown[]).length
            : 0,
        tools: Array.isArray((scrubbed as Record<string, unknown>).tools)
            ? ((scrubbed as Record<string, unknown>).tools as unknown[]).length
            : 0,
        tool_choice: (scrubbed as Record<string, unknown>).tool_choice ?? "<absent>",
        orig_tools: Array.isArray((original as Record<string, unknown>).tools)
            ? ((original as Record<string, unknown>).tools as unknown[]).length
            : 0,
        orig_tool_choice: (original as Record<string, unknown>).tool_choice ?? "<absent>",
    });
    return { init: { ...init, body: JSON.stringify(scrubbed) }, original, rewritten: scrubbed };
}

function buildHeaders(init: RequestInit | undefined, account: OpenWebUIAccount, isStreaming: boolean): Headers {
    const headers = new Headers();
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => headers.set(key, value));
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
    headers.set("content-type", headers.get("content-type") ?? "application/json");
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

    const wrappedUserStream = new ReadableStream({
        async start(controller) {
            const reader = userStream.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    controller.enqueue(value);
                }
                controller.close();
            } catch (e) {
                controller.error(e);
            } finally {
                reader.releaseLock();
            }
        },
        cancel() {
            abortController.abort();
        },
    });

    (async () => {
        const reader = usageStream.getReader();
        try {
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                if (abortController.signal.aborted) break;
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 4096) {
                    buffer = buffer.slice(-4096);
                }
            }

            const usageMatches = [
                ...buffer.matchAll(/"usage"\s*:\s*\{[^}]*"completion_tokens"\s*:\s*(\d+)[^}]*\}/g),
            ];
            const usageMatch = usageMatches.length > 0 ? usageMatches[usageMatches.length - 1] : null;
            if (usageMatch) {
                const block = usageMatch[0];
                const promptMatch = block.match(/"prompt_tokens"\s*:\s*(\d+)/);
                const completionMatch = block.match(/"completion_tokens"\s*:\s*(\d+)/);
                const cachedMatch = block.match(/"cached_tokens"\s*:\s*(\d+)/);

                const input = promptMatch ? parseInt(promptMatch[1], 10) : 0;
                const output = completionMatch ? parseInt(completionMatch[1], 10) : 0;
                const cacheRead = cachedMatch ? parseInt(cachedMatch[1], 10) : 0;

                log(`[usage] ${accountName} model=${modelId ?? "unknown"}: in=${input} out=${output} cache_read=${cacheRead}`);

                await storage.addUsage(accountName, {
                    input,
                    output,
                    cacheRead,
                    cacheWrite: 0,
                    model: modelId,
                });
            }
        } catch {
            // Usage tracking is best-effort
        } finally {
            reader.releaseLock();
            try { await usageStream.cancel(); } catch {}
        }
    })().catch((e) => log(`[usage-extract] failed: ${e?.message ?? e}`));

    return new Response(wrappedUserStream, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    });
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
        if (isTokenExpired(account.token, 0)) {
            log(`[fetch] token expired for ${account.name} — attempting auto-refresh`);
            const username = process.env.OWUI_USERNAME;
            const password = process.env.OWUI_PASSWORD;
            if (username && password) {
                try {
                    const result = await oidcLogin({
                        baseUrl: account.baseUrl,
                        username,
                        password,
                        duoPasscode: process.env.OWUI_DUO_PASSCODE,
                        duoMethod: process.env.OWUI_DUO_PASSCODE ? "passcode" : "push",
                    });
                    account = {
                        ...account,
                        token: result.token,
                        expiresAt: result.expiresAt,
                        updatedAt: Date.now(),
                    };
                    await storage.upsert(account);
                    log(`[fetch] auto-refreshed token for ${account.name}, expires ${new Date(result.expiresAt).toISOString()}`);
                } catch (err) {
                    log(`[fetch] auto-refresh failed: ${err instanceof Error ? err.message : err}`);
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
        const { init: rewritten, rewritten: parsedBody } = rewriteBody(init, url.toString());

        const isChatCompletions = url.pathname.includes("/chat/completions");
        const accountForUsage = account.name;
        let requestModelId: string | undefined;
        if (parsedBody && typeof parsedBody === "object") {
            const m = (parsedBody as Record<string, unknown>).model;
            if (typeof m === "string") requestModelId = m;
        }

        const isStreaming = Boolean(
            rewritten?.body
            && typeof rewritten.body === "string"
            && rewritten.body.includes('"stream":true'),
        );
        const headers = buildHeaders(init, account, isStreaming);

        const incomingSignal = rewritten?.signal as AbortSignal | undefined;
        const safetySignal = AbortSignal.timeout(SAFETY_TIMEOUT_MS);
        const signals: AbortSignal[] = [safetySignal];
        if (incomingSignal) signals.push(incomingSignal);
        const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

        const fetchOpts: RequestInit = {
            ...rewritten,
            headers,
            signal: combinedSignal,
        };

        let lastRes: Response | undefined;
        let didAuthRetry = false;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
                log(`[fetch] retry #${attempt} in ${delay}ms after ${lastRes?.status ?? "?"}...`);
                await new Promise((r) => setTimeout(r, delay));
            }

            logRequest(url.toString(), init?.method ?? "GET");
            const res = await fetch(url, fetchOpts);
            logResponse(url.toString(), res.status);
            lastRes = res;

            if (res.ok) {
                if (isChatCompletions && res.body && accountForUsage) {
                    return interceptUsage(res, storage, accountForUsage, requestModelId);
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
                            duoMethod: process.env.OWUI_DUO_PASSCODE ? "passcode" : "push",
                        });
                        account = {
                            ...account,
                            token: result.token,
                            expiresAt: result.expiresAt,
                            updatedAt: Date.now(),
                        };
                        await storage.upsert(account);
                        headers.set("authorization", `Bearer ${account.token}`);
                        log(`[fetch] refreshed token for ${account.name} after ${res.status}`);
                        attempt--;
                        continue;
                    } catch (err) {
                        log(`[fetch] auth refresh failed: ${err instanceof Error ? err.message : err}`);
                    }
                }
            }

            if (RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
                try {
                    const text = await res.text();
                    bodyLog(RES_LOG, { url: url.toString(), status: res.status, body: text.slice(0, 500), attempt });
                } catch {}
                continue;
            }

            if (!res.ok) {
                try {
                    const clone = res.clone();
                    const text = await clone.text();
                    bodyLog(RES_LOG, { url: url.toString(), status: res.status, body: text.slice(0, 2000) });

                    if (text.includes("<html") || text.includes("<!DOCTYPE")) {
                        const errorJson = JSON.stringify({
                            error: { message: `Upstream error ${res.status} (nginx/proxy)`, type: "proxy_error", code: res.status },
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
        return lastRes!;
    };
}
