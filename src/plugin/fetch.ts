import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isTokenExpired } from "../oauth/jwt";
import { oidcLogin } from "../oauth/oidc-login";
import { log, logRequest, logResponse } from "../logger";
import type { Storage } from "../storage";
import type { OpenWebUIAccount } from "../types";

const BODY_LOG_DIR = "/tmp/opencode-openwebui-auth";
const REQ_LOG = join(BODY_LOG_DIR, "requests.log");
const RES_LOG = join(BODY_LOG_DIR, "responses.log");
const SUMMARY_LOG = join(BODY_LOG_DIR, "summary.log");
try {
    mkdirSync(BODY_LOG_DIR, { recursive: true });
} catch {}

function bodyLog(path: string, entry: Record<string, unknown>): void {
    try {
        appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {}
}

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
    bodyLog(REQ_LOG, { url, original, scrubbed });
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

function buildHeaders(init: RequestInit | undefined, account: OpenWebUIAccount): Headers {
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
                    storage.upsert(account);
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
        const headers = buildHeaders(init, account);
        const { init: rewritten } = rewriteBody(init, url.toString());

        logRequest(url.toString(), init?.method ?? "GET");
        const res = await fetch(url, { ...rewritten, headers });
        logResponse(url.toString(), res.status);

        // On non-2xx, clone and capture the response body for debugging
        if (!res.ok) {
            try {
                const clone = res.clone();
                const text = await clone.text();
                bodyLog(RES_LOG, { url: url.toString(), status: res.status, body: text });
            } catch {}
        }
        return res;
    };
}
