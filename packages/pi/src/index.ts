import {
    fetchInstanceConfig,
    inferModelLimits,
    listModels,
    log,
    normalizeBaseUrl,
    oidcLogin,
    type OpenWebUIModelInfo,
    parseJwtClaims,
    Storage,
    verifyToken,
} from "@openwebui-auth/core";
import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi extension: register OpenWebUI as an OpenAI-compatible provider whose auth
 * is a University-of-Arizona Shibboleth+Duo OIDC login. The OWUI JWT is the
 * bearer key; there is no refresh token, so "refresh" re-runs the OIDC flow.
 */

const DEFAULT_BASE_URL =
    process.env.OWUI_BASE_URL?.trim() || "https://chat.ai2s.org";

function envBaseUrl(): string {
    return normalizeBaseUrl(DEFAULT_BASE_URL);
}

/** OWUI issues a single JWT, not an access/refresh pair. Map it onto the pi
 *  OAuthCredentials shape: access = JWT, refresh = the JWT too (so a later
 *  refreshToken() call has something to detect staleness against), expires =
 *  the JWT exp. */
function toCredentials(token: string, expiresAt: number): OAuthCredentials {
    return { access: token, refresh: token, expires: expiresAt };
}

/**
 * Run the automated OWUI OIDC login (Shibboleth + Duo Universal Prompt).
 * Credentials come from env (OWUI_USERNAME / OWUI_PASSWORD / OWUI_DUO_PASSCODE);
 * pi prompts fill any gaps interactively.
 */
export async function loginOpenWebUI(
    callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
    const baseUrl = envBaseUrl();

    const username =
        process.env.OWUI_USERNAME?.trim() ||
        (await callbacks.onPrompt({ message: "NetID / username:" }));
    const password =
        process.env.OWUI_PASSWORD ||
        (await callbacks.onPrompt({
            message: "Password (hidden by pi):",
        }));
    const duoPasscode =
        process.env.OWUI_DUO_PASSCODE?.trim() ||
        (await callbacks.onPrompt({
            message: "Duo 6-digit passcode (blank = push):",
            allowEmpty: true,
        }));

    callbacks.onProgress?.(
        "Authenticating with Shibboleth + Duo (approve the push if prompted)...",
    );

    const result = await oidcLogin({
        baseUrl,
        username,
        password,
        duoMethod: duoPasscode ? "passcode" : "push",
        duoPasscode: duoPasscode || undefined,
    });

    // Persist to the shared account store so the opencode CLI and pi agree.
    const user = await verifyToken(baseUrl, result.token);
    const cfg = await fetchInstanceConfig(baseUrl).catch(() => null);
    const storage = new Storage();
    await storage.upsert({
        name: `${user.email}@${new URL(baseUrl).host}`,
        baseUrl,
        token: result.token,
        expiresAt: result.expiresAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    log(
        `[pi] OWUI login ok (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"})`,
    );

    return toCredentials(result.token, result.expiresAt);
}

/**
 * "Refresh" for OWUI = re-run the OIDC login, because the JWT is a fixed-window
 * token with no refresh grant. Requires env credentials; interactive Duo push
 * still needs device approval unless OWUI_DUO_PASSCODE is set.
 */
export async function refreshOpenWebUIToken(
    credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
    // Still valid? Hand it straight back — the JWT does not rotate.
    if (
        typeof credentials.access === "string" &&
        !isJwtExpired(credentials.access)
    ) {
        return credentials;
    }

    const username = process.env.OWUI_USERNAME?.trim();
    const password = process.env.OWUI_PASSWORD;
    if (!username || !password) {
        throw new Error(
            "OpenWebUI token expired and no refresh grant exists. Set " +
                "OWUI_USERNAME + OWUI_PASSWORD (and optionally OWUI_DUO_PASSCODE) " +
                "for unattended re-login, or run /login openwebui again.",
        );
    }

    const baseUrl = envBaseUrl();
    const result = await oidcLogin({
        baseUrl,
        username,
        password,
        duoMethod: process.env.OWUI_DUO_PASSCODE ? "passcode" : "push",
        duoPasscode: process.env.OWUI_DUO_PASSCODE,
    });
    return toCredentials(result.token, result.expiresAt);
}

function isJwtExpired(token: string, skewMs = 60_000): boolean {
    const claims = parseJwtClaims(token);
    if (!claims) return true;
    return Date.now() + skewMs >= claims.exp * 1000;
}

function toPiModel(baseUrl: string, raw: OpenWebUIModelInfo) {
    const caps = raw.info?.meta?.capabilities ?? {};
    const limits = inferModelLimits(raw.id, raw.name ?? "");
    const image = Boolean(caps.vision);
    return {
        id: raw.id,
        name: raw.name ?? raw.id,
        api: "openai" as const,
        baseUrl: `${baseUrl}/api`,
        reasoning: /claude|gpt-?5|o[0-9]/i.test(raw.id),
        input: (image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: limits.context,
        maxTokens: limits.output,
    };
}

/** Fetch the live model catalog for the current account, if one exists. */
export async function resolvePiModelCatalog() {
    const baseUrl = envBaseUrl();
    const account = new Storage().getCurrent();
    if (!account) return [];
    try {
        const { data } = await listModels(account.baseUrl, account.token);
        return data.map((m) => toPiModel(account.baseUrl, m));
    } catch (err) {
        log(
            `[pi] model discovery failed: ${err instanceof Error ? err.message : err}`,
        );
        return [];
    }
}

export default async function openWebUiPiAuth(pi: ExtensionAPI) {
    const baseUrl = envBaseUrl();
    const models = await resolvePiModelCatalog();

    pi.registerProvider("openwebui", {
        name: "OpenWebUI (Shibboleth OIDC)",
        baseUrl: `${baseUrl}/api`,
        api: "openai",
        authHeader: true,
        models,
        oauth: {
            name: "OpenWebUI (U of A GenAI)",
            login: loginOpenWebUI,
            refreshToken: refreshOpenWebUIToken,
            getApiKey: (credentials) => credentials.access,
        },
    });
}
