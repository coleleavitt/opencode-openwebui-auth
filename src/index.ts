import type { PluginInput } from "@opencode-ai/plugin";
import { Storage } from "./storage";
import { log, logAuth } from "./logger";
import { fetchInstanceConfig, normalizeBaseUrl, verifyToken } from "./oauth/api";
import { parseJwtClaims } from "./oauth/jwt";
import { oidcLogin } from "./oauth/oidc-login";
import { makeOwuiFetch } from "./plugin/fetch";
import type { OpenWebUIAccount } from "./types";

const PROVIDER_ID = "openwebui";
const DUMMY_KEY = "owui-plugin-managed";
const DEFAULT_BASE_URL = "https://chat.ai2s.org";

async function persistAccount(
    storage: Storage,
    baseUrl: string,
    token: string,
    expiresAt: number,
    note: string,
): Promise<void> {
    const user = await verifyToken(baseUrl, token);
    const cfg = await fetchInstanceConfig(baseUrl).catch(() => null);
    const name = `${user.email}@${new URL(baseUrl).host}`;
    storage.upsert({
        name, baseUrl, token, expiresAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    logAuth(name, `${note} (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"})`);
}

export const OpenWebUIAuthPlugin = async (_input: PluginInput) => {
    const storage = new Storage();
    const owuiFetch = makeOwuiFetch(storage);

    return {
        auth: {
            provider: PROVIDER_ID,
            async loader(_getAuth: unknown, provider: { models?: Record<string, { cost?: unknown }> }) {
                const account = storage.getCurrent();
                if (!account) {
                    log("[loader] no account configured");
                    return {};
                }
                for (const model of Object.values(provider.models ?? {})) {
                    model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
                }
                return { apiKey: DUMMY_KEY, fetch: owuiFetch };
            },
            methods: [
                {
                    type: "api" as const,
                    label: "Automated OIDC (Shibboleth + Duo 2FA)",
                    prompts: [
                        {
                            type: "text" as const,
                            key: "baseUrl",
                            message: "OpenWebUI base URL",
                            placeholder: process.env.OWUI_BASE_URL ?? DEFAULT_BASE_URL,
                        },
                        {
                            type: "text" as const,
                            key: "username",
                            message: "NetID / username (or set OWUI_USERNAME)",
                            validate: (v: string) =>
                                v || process.env.OWUI_USERNAME ? undefined : "Required",
                        },
                        {
                            type: "text" as const,
                            key: "password",
                            message: "Password (or set OWUI_PASSWORD — visible on screen!)",
                            validate: (v: string) =>
                                v || process.env.OWUI_PASSWORD ? undefined : "Required",
                        },
                        {
                            type: "select" as const,
                            key: "duoMethod",
                            message: "Duo 2FA method",
                            options: [
                                { label: "Duo Push (approve on phone)", value: "push", hint: "default" },
                                { label: "Duo Mobile passcode (6-digit code)", value: "passcode" },
                            ],
                        },
                        {
                            type: "text" as const,
                            key: "duoPasscode",
                            message: "6-digit Duo Mobile passcode",
                            placeholder: "123456",
                            when: { key: "duoMethod", op: "eq" as const, value: "passcode" },
                            validate: (v: string) =>
                                /^\d{6}$/.test(v) ? undefined : "Must be 6 digits",
                        },
                    ],
                    async authorize(inputs?: Record<string, string>) {
                        try {
                            const baseUrl = normalizeBaseUrl(
                                inputs?.baseUrl || process.env.OWUI_BASE_URL || DEFAULT_BASE_URL,
                            );
                            const result = await oidcLogin({
                                baseUrl,
                                username: inputs?.username || process.env.OWUI_USERNAME!,
                                password: inputs?.password || process.env.OWUI_PASSWORD!,
                                duoMethod: (inputs?.duoMethod as "push" | "passcode") ?? "push",
                                duoPasscode: inputs?.duoPasscode || process.env.OWUI_DUO_PASSCODE,
                            });
                            await persistAccount(storage, baseUrl, result.token, result.expiresAt, "automated OIDC login");
                            return { type: "success" as const, key: DUMMY_KEY };
                        } catch (err) {
                            log(`[auth] OIDC login failed: ${err instanceof Error ? err.message : err}`);
                            return { type: "failed" as const };
                        }
                    },
                },
                {
                    type: "api" as const,
                    label: "Paste OpenWebUI JWT manually",
                    prompts: [
                        {
                            type: "text" as const,
                            key: "baseUrl",
                            message: "OpenWebUI base URL",
                            placeholder: process.env.OWUI_BASE_URL ?? DEFAULT_BASE_URL,
                        },
                        {
                            type: "text" as const,
                            key: "token",
                            message: "JWT (DevTools → Cookies → token)",
                            validate: (v: string) =>
                                v && v.split(".").length === 3 ? undefined : "Must be a 3-segment JWT",
                        },
                    ],
                    async authorize(inputs?: Record<string, string>) {
                        try {
                            const baseUrl = normalizeBaseUrl(
                                inputs?.baseUrl || process.env.OWUI_BASE_URL || DEFAULT_BASE_URL,
                            );
                            const token = inputs!.token;
                            const claims = parseJwtClaims(token);
                            if (!claims) throw new Error("Token does not decode as a JWT");
                            await persistAccount(storage, baseUrl, token, claims.exp * 1000, "manual paste");
                            return { type: "success" as const, key: DUMMY_KEY };
                        } catch (err) {
                            log(`[auth] manual login failed: ${err instanceof Error ? err.message : err}`);
                            return { type: "failed" as const };
                        }
                    },
                },
            ],
        },
        "chat.params": async (
            input: { provider: { id: string } },
            output: { options: Record<string, unknown> },
        ) => {
            if (input.provider.id !== PROVIDER_ID) return;
            output.options = {
                ...(output.options ?? {}),
                stream_options: { include_usage: true },
            };
        },
    };
};

export default OpenWebUIAuthPlugin;

export type { OpenWebUIAccount } from "./types";
