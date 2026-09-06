import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
    fetchInstanceConfig,
    inferModelLimits,
    listModels,
    log,
    ModelCatalogCache,
    normalizeBaseUrl,
    type OpenWebUIAccount,
    type OpenWebUIModelInfo,
    oidcLogin,
    parseJwtClaims,
    Storage,
    verifyToken,
} from "@openwebui-auth/core";

import { streamOpenWebUI } from "./stream";

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

type PiModel = ReturnType<typeof toPiModel>;

/**
 * A cached catalog younger than this is served at startup without any
 * discovery request. Older caches are still served immediately, but a refresh
 * runs in the background and re-registers the provider when the list changed.
 */
export const MODEL_CATALOG_MAX_AGE_MS = 10 * 60 * 1000;

/** Injection seams so catalog behaviour is testable without a network or a store. */
export interface ModelCatalogDeps {
    cache?: ModelCatalogCache<PiModel>;
    getAccount?: () => OpenWebUIAccount | undefined;
    fetchModels?: (
        baseUrl: string,
        token: string,
    ) => Promise<{ data: OpenWebUIModelInfo[] }>;
    /** Cache age below which startup skips discovery (default 10 minutes). */
    maxAgeMs?: number;
}

/**
 * Fetch the live model catalog for the current account.
 *
 * Discovery runs while the agent starts, so a network failure must not empty
 * the model list: fall back to the last catalog seen for the same host.
 */
export async function resolvePiModelCatalog(
    deps: ModelCatalogDeps = {},
): Promise<PiModel[]> {
    const cache = deps.cache ?? new ModelCatalogCache<PiModel>();
    const account = (deps.getAccount ?? (() => new Storage().getCurrent()))();
    if (!account) return [];
    const fetchModels = deps.fetchModels ?? listModels;

    try {
        const { data } = await fetchModels(account.baseUrl, account.token);
        const models = data.map((m) => toPiModel(account.baseUrl, m));
        if (models.length > 0) {
            cache.save(account.baseUrl, models);
            return models;
        }
        log("[pi] model discovery returned no models");
    } catch (err) {
        log(
            `[pi] model discovery failed: ${err instanceof Error ? err.message : err}`,
        );
    }

    const cached = cache.load(account.baseUrl);
    if (!cached) return [];
    const ageMinutes = Math.round((Date.now() - cached.fetchedAt) / 60_000);
    log(
        `[pi] serving ${cached.models.length} cached models for ${account.baseUrl} (${ageMinutes}m old)`,
    );
    return cached.models;
}

/** What the provider registers with at startup, plus a possible later update. */
export interface StartupModelCatalog {
    models: PiModel[];
    /** `cache` = served from disk, `live` = awaited discovery, `none` = no account/models. */
    source: "cache" | "live" | "none";
    /**
     * Background discovery for a stale cache. Resolves with the fresh catalog
     * when it differs from `models`, otherwise `undefined`. Never rejects.
     */
    refresh: Promise<PiModel[] | undefined>;
}

function sameCatalog(a: PiModel[], b: PiModel[]): boolean {
    return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Cache-first catalog for session start.
 *
 * The extension factory used to await a live `/api/models` round-trip on every
 * session start (~200-450 ms, the whole cost of loading this extension). Now a
 * fresh cache resolves with no network I/O, a stale cache is served at once
 * while discovery refreshes it in the background, and only a cold start (no
 * cache for this host) still waits on the network like before.
 */
export async function resolveStartupPiModelCatalog(
    deps: ModelCatalogDeps = {},
): Promise<StartupModelCatalog> {
    const cache = deps.cache ?? new ModelCatalogCache<PiModel>();
    const account = (deps.getAccount ?? (() => new Storage().getCurrent()))();
    const noRefresh = Promise.resolve(undefined);
    if (!account) return { models: [], source: "none", refresh: noRefresh };

    const live: ModelCatalogDeps = {
        ...deps,
        cache,
        getAccount: () => account,
    };
    const cached = cache.load(account.baseUrl);
    if (!cached) {
        const models = await resolvePiModelCatalog(live);
        return {
            models,
            source: models.length > 0 ? "live" : "none",
            refresh: noRefresh,
        };
    }

    const ageMs = Date.now() - cached.fetchedAt;
    const ageMinutes = Math.round(ageMs / 60_000);
    if (ageMs < (deps.maxAgeMs ?? MODEL_CATALOG_MAX_AGE_MS)) {
        log(
            `[pi] serving ${cached.models.length} cached models for ${account.baseUrl} (${ageMinutes}m old, fresh)`,
        );
        return { models: cached.models, source: "cache", refresh: noRefresh };
    }

    log(
        `[pi] serving ${cached.models.length} cached models for ${account.baseUrl} (${ageMinutes}m old), refreshing in background`,
    );
    // resolvePiModelCatalog never throws: a failed or empty discovery falls
    // back to the same cached list, which compares equal and yields no update.
    const refresh = resolvePiModelCatalog(live).then(
        (fresh) =>
            fresh.length > 0 && !sameCatalog(fresh, cached.models)
                ? fresh
                : undefined,
        (err) => {
            log(
                `[pi] background model refresh failed: ${err instanceof Error ? err.message : err}`,
            );
            return undefined;
        },
    );
    return { models: cached.models, source: "cache", refresh };
}

function providerConfig(baseUrl: string, models: PiModel[]): ProviderConfig {
    return {
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
        // Custom transport: OWUI -> LiteLLM -> Bedrock request shaping, retry
        // (429/Retry-After, 5xx, LiteLLM-mislabeled 400), OIDC re-auth, SSE
        // parsing, and usage accounting. Mirrors the opencode fetch shim.
        streamSimple: streamOpenWebUI,
    };
}

/** Factory seams: the real one reads the account store and the model cache. */
export interface OpenWebUiPiAuthDeps {
    catalog?: ModelCatalogDeps;
}

export default async function openWebUiPiAuth(
    pi: ExtensionAPI,
    deps: OpenWebUiPiAuthDeps = {},
) {
    // Read the account store once; the catalog and the provider record share it.
    const account = (
        deps.catalog?.getAccount ?? (() => new Storage().getCurrent())
    )();
    const catalog = await resolveStartupPiModelCatalog({
        ...deps.catalog,
        getAccount: () => account,
    });
    // The provider must advertise the host the models and the stream actually
    // use. The env default is only a fallback for a first-time login, so a
    // stored account whose host differs no longer leaves the provider record
    // pointing somewhere the requests never go.
    const baseUrl = account?.baseUrl ?? envBaseUrl();

    pi.registerProvider("openwebui", providerConfig(baseUrl, catalog.models));

    // A stale cache was served above; when discovery finds a different list,
    // re-register so the picker sees it. Re-registering with `models` replaces
    // the provider's model list in pi's registry. The extension may already be
    // disposed (ctx.reload) by the time this lands; that throw is only logged.
    void catalog.refresh.then((fresh) => {
        if (!fresh) return;
        try {
            pi.registerProvider("openwebui", providerConfig(baseUrl, fresh));
            log(`[pi] catalog refreshed: ${fresh.length} models`);
        } catch (err) {
            log(
                `[pi] catalog refresh not applied: ${err instanceof Error ? err.message : err}`,
            );
        }
    });
}
