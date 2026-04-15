import type { PluginInput } from "@opencode-ai/plugin";
import { log, logAuth } from "./logger";
import {
    fetchInstanceConfig,
    normalizeBaseUrl,
    verifyToken,
} from "./oauth/api";
import { browserLogin } from "./oauth/browser-auth";
import { parseJwtClaims } from "./oauth/jwt";
import { makeOwuiFetch } from "./plugin/fetch";
import { Storage } from "./storage";
import type { OpenWebUIAccount } from "./types";

const PROVIDER_ID = "openwebui";
const DUMMY_KEY = "owui-plugin-managed";

export const OpenWebUIAuthPlugin = async (_input: PluginInput) => {
    const storage = new Storage();
    const owuiFetch = makeOwuiFetch(storage);

    return {
        auth: {
            provider: PROVIDER_ID,
            async loader(
                _getAuth: unknown,
                provider: { models?: Record<string, { cost?: unknown }> },
            ) {
                const account = storage.getCurrent();
                if (!account) {
                    log("[loader] no account configured");
                    return {};
                }

                // Zero cost — the instance owner pays, not the user
                for (const model of Object.values(provider?.models ?? {})) {
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
                    label: "OpenWebUI — Browser Sign-In (SSO)",
                    type: "oauth",
                    prompts: [
                        {
                            type: "text",
                            key: "baseUrl",
                            message:
                                "OpenWebUI base URL (e.g. https://chat.example.org)",
                        },
                    ],
                    async authorize(
                        inputs: Record<string, string> | undefined,
                    ) {
                        const raw =
                            inputs?.baseUrl?.trim() ||
                            process.env.OWUI_BASE_URL;
                        if (!raw) {
                            throw new Error(
                                "No base URL provided. Set OWUI_BASE_URL or enter the URL when prompted.",
                            );
                        }
                        const baseUrl = normalizeBaseUrl(raw);

                        return {
                            url: `${baseUrl}/oauth/oidc/login`,
                            method: "auto" as const,
                            instructions:
                                "Complete SSO login in the browser, then copy the token via the bridge page.",
                            async callback() {
                                // browserLogin() starts a local HTTP server,
                                // opens the browser to the bridge page, and
                                // resolves when the user pastes the token.
                                const token = await browserLogin(baseUrl);

                                const claims = parseJwtClaims(token);
                                if (!claims) {
                                    return { type: "failed" as const };
                                }

                                const user = await verifyToken(baseUrl, token);
                                const cfg = await fetchInstanceConfig(
                                    baseUrl,
                                ).catch(() => null);
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
                                logAuth(
                                    name,
                                    `added (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"})`,
                                );

                                return {
                                    type: "success" as const,
                                    key: DUMMY_KEY,
                                };
                            },
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

export { listModels } from "./oauth/api";
// Re-exports for tooling
export { Storage } from "./storage";
export type { OpenWebUIAccount } from "./types";
