import { isTokenExpired } from "../oauth/jwt";
import { log, logRequest, logResponse } from "../logger";
import type { Storage } from "../storage";
import type { OpenWebUIAccount } from "../types";

const OWUI_SENSITIVE_HEADERS = new Set(["x-api-key", "anthropic-version", "anthropic-beta"]);

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
        const account = storage.getCurrent();
        if (!account) {
            throw new Error(
                "No OpenWebUI account configured. Run: opencode auth login openwebui",
            );
        }
        if (account.disabled) {
            throw new Error(`Account ${account.name} is disabled`);
        }
        if (isTokenExpired(account.token, 0)) {
            log(`[fetch] token expired for ${account.name} (exp check)`);
            throw new Error(
                `Token for ${account.name} is expired. Re-run: opencode auth login openwebui`,
            );
        }

        const url = rewriteUrl(input, account.baseUrl);
        const headers = buildHeaders(init, account);

        logRequest(url.toString(), init?.method ?? "GET");
        const res = await fetch(url, { ...init, headers });
        logResponse(url.toString(), res.status);
        return res;
    };
}
