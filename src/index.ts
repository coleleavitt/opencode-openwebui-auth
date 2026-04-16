import type { PluginInput } from "@opencode-ai/plugin";
import { Storage } from "./storage";
import { log, logAuth } from "./logger";
import { fetchInstanceConfig, listModels, normalizeBaseUrl, verifyToken } from "./oauth/api";
import { parseJwtClaims } from "./oauth/jwt";
import { makeOwuiFetch } from "./plugin/fetch";
import type { OpenWebUIAccount } from "./types";

const PROVIDER_ID = "openwebui";
const DUMMY_KEY = "owui-plugin-managed";

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

                // Zero cost — the instance owner pays, not the user
                for (const model of Object.values(provider.models ?? {})) {
                    model.cost = {
                        input: 0,
                        output: 0,
                        cache: { read: 0, write: 0 },
                    };
                }

                return {
                    apiKey: DUMMY_KEY,
                    fetch: owuiFetch,
                };
            },
            methods: [
                {
                    label: "OpenWebUI instance + JWT",
                    type: "api",
                    async authorize() {
                        return {
                            instructions: [
                                "Paste your OpenWebUI bearer token (JWT).",
                                "Get it from your browser DevTools: Application > Cookies > token,",
                                "or from Settings > Account in the UI.",
                                "",
                                "Also set OWUI_BASE_URL (e.g. https://chat.ai2s.org) in your opencode.json",
                                "provider config, or use the `opencode auth` interactive form.",
                            ].join("\n"),
                            method: "api-key" as const,
                        };
                    },
                    async callback(token: string) {
                        const baseUrl = normalizeBaseUrl(
                            process.env.OWUI_BASE_URL ?? "https://chat.ai2s.org",
                        );
                        const claims = parseJwtClaims(token);
                        if (!claims) {
                            throw new Error("Provided token does not decode as a JWT");
                        }
                        const user = await verifyToken(baseUrl, token);
                        const cfg = await fetchInstanceConfig(baseUrl).catch(() => null);
                        const name = `${user.email}@${new URL(baseUrl).host}`;
                        const account: OpenWebUIAccount = {
                            name,
                            baseUrl,
                            token,
                            expiresAt: claims.exp * 1000,
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        };
                        storage.upsert(account);
                        logAuth(name, `added (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"})`);
                        return {
                            type: "success" as const,
                            key: DUMMY_KEY,
                        };
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

// NOTE: Do NOT re-export Storage/classes/functions here — opencode's
// getLegacyPlugins scans ALL module exports and calls every function it finds
// as a plugin factory, which crashes on class constructors. CLI tooling
// should import directly from ./storage etc.
export type { OpenWebUIAccount } from "./types";
