import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCache, type OpenWebUIAccount } from "@openwebui-auth/core";

import openWebUiPiAuth, {
    MODEL_CATALOG_MAX_AGE_MS,
    resolvePiModelCatalog,
    resolveStartupPiModelCatalog,
} from "./index";

type CachedPiModel = Awaited<ReturnType<typeof resolvePiModelCatalog>>[number];

const dirs: string[] = [];

function tempCache() {
    const dir = mkdtempSync(join(tmpdir(), "owui-pi-models-"));
    dirs.push(dir);
    return new ModelCatalogCache<CachedPiModel>(
        join(dir, "openwebui-models.json"),
    );
}

const ACCOUNT: OpenWebUIAccount = {
    name: "user@owui.example",
    baseUrl: "https://owui.example",
    token: "jwt",
    createdAt: 1,
    updatedAt: 1,
};

const RESPONSE = {
    data: [
        { id: "openai.gpt-5.6-sol", name: "GPT 5.6 Sol" },
        { id: "bedrock-claude-5-opus", name: "Claude Opus 5" },
    ],
};

const NEWER_RESPONSE = {
    data: [
        ...RESPONSE.data,
        { id: "bedrock-claude-5-sonnet", name: "Sonnet 5" },
    ],
};

/** Write a catalog whose fetchedAt is `ageMs` in the past. */
async function seedCache(cache: ModelCatalogCache<CachedPiModel>, ageMs = 0) {
    await resolvePiModelCatalog({
        cache,
        getAccount: () => ACCOUNT,
        fetchModels: async () => RESPONSE,
    });
    if (ageMs > 0) {
        const path = (cache as unknown as { path: string }).path;
        const file = JSON.parse(readFileSync(path, "utf8"));
        file.fetchedAt = Date.now() - ageMs;
        writeFileSync(path, JSON.stringify(file));
    }
}

const STALE = MODEL_CATALOG_MAX_AGE_MS + 60_000;

/** Minimal ExtensionAPI stand-in recording provider registrations. */
function fakePi() {
    const registrations: Array<{ name: string; models: CachedPiModel[] }> = [];
    const pi = {
        registerProvider(name: string, config: { models?: CachedPiModel[] }) {
            registrations.push({ name, models: config.models ?? [] });
        },
    };
    return {
        pi: pi as unknown as Parameters<typeof openWebUiPiAuth>[0],
        registrations,
    };
}

afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

describe("resolvePiModelCatalog", () => {
    test("returns the live catalog and remembers it", async () => {
        const cache = tempCache();
        const models = await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });

        expect(models.map((m) => m.id)).toEqual([
            "openai.gpt-5.6-sol",
            "bedrock-claude-5-opus",
        ]);
        expect(models[0]?.baseUrl).toBe("https://owui.example/api");
        expect(cache.load("https://owui.example")?.models).toHaveLength(2);
    });

    // Regression: discovery failure used to return [], so the provider
    // registered with zero models and every OpenWebUI model disappeared.
    test("serves the cached catalog when discovery fails", async () => {
        const cache = tempCache();
        await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });

        const models = await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                throw new Error("getaddrinfo ENOTFOUND owui.example");
            },
        });

        expect(models.map((m) => m.id)).toEqual([
            "openai.gpt-5.6-sol",
            "bedrock-claude-5-opus",
        ]);
    });

    test("serves the cached catalog when discovery returns nothing", async () => {
        const cache = tempCache();
        await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });

        const models = await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => ({ data: [] }),
        });

        expect(models).toHaveLength(2);
    });

    test("returns nothing when discovery fails with no cache to fall back on", async () => {
        const models = await resolvePiModelCatalog({
            cache: tempCache(),
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                throw new Error("offline");
            },
        });
        expect(models).toEqual([]);
    });

    test("returns nothing when no account is logged in", async () => {
        let fetched = false;
        const models = await resolvePiModelCatalog({
            cache: tempCache(),
            getAccount: () => undefined,
            fetchModels: async () => {
                fetched = true;
                return RESPONSE;
            },
        });
        expect(models).toEqual([]);
        expect(fetched).toBe(false);
    });

    test("does not cache a catalog under a host it did not come from", async () => {
        const cache = tempCache();
        await resolvePiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });
        expect(cache.load("https://other.example")).toBeUndefined();
    });
});

describe("resolveStartupPiModelCatalog", () => {
    test("a fresh cache is served without any discovery request", async () => {
        const cache = tempCache();
        await seedCache(cache);
        let fetched = 0;

        const startup = await resolveStartupPiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                fetched++;
                return NEWER_RESPONSE;
            },
        });

        expect(startup.source).toBe("cache");
        expect(startup.models).toHaveLength(2);
        expect(await startup.refresh).toBeUndefined();
        expect(fetched).toBe(0);
    });

    test("a stale cache is served at once and refreshed in the background", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });

        const started = Date.now();
        const startup = await resolveStartupPiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                await gate;
                return NEWER_RESPONSE;
            },
        });
        // Startup did not wait on the (blocked) discovery call.
        expect(Date.now() - started).toBeLessThan(500);
        expect(startup.source).toBe("cache");
        expect(startup.models.map((m) => m.id)).toEqual([
            "openai.gpt-5.6-sol",
            "bedrock-claude-5-opus",
        ]);

        release();
        const fresh = await startup.refresh;
        expect(fresh?.map((m) => m.id)).toEqual([
            "openai.gpt-5.6-sol",
            "bedrock-claude-5-opus",
            "bedrock-claude-5-sonnet",
        ]);
        expect(cache.load(ACCOUNT.baseUrl)?.models).toHaveLength(3);
    });

    test("a stale cache whose refresh returns the same list yields no update", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        const startup = await resolveStartupPiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });
        expect(await startup.refresh).toBeUndefined();
    });

    test("a stale cache survives a failed background refresh", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        const startup = await resolveStartupPiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                throw new Error("getaddrinfo ENOTFOUND owui.example");
            },
        });
        expect(startup.models).toHaveLength(2);
        expect(await startup.refresh).toBeUndefined();
        expect(cache.load(ACCOUNT.baseUrl)?.models).toHaveLength(2);
    });

    test("a cold start still awaits discovery", async () => {
        const cache = tempCache();
        const startup = await resolveStartupPiModelCatalog({
            cache,
            getAccount: () => ACCOUNT,
            fetchModels: async () => RESPONSE,
        });
        expect(startup.source).toBe("live");
        expect(startup.models).toHaveLength(2);
        expect(await startup.refresh).toBeUndefined();
    });

    test("a cold start with discovery down registers nothing, as before", async () => {
        const startup = await resolveStartupPiModelCatalog({
            cache: tempCache(),
            getAccount: () => ACCOUNT,
            fetchModels: async () => {
                throw new Error("offline");
            },
        });
        expect(startup.source).toBe("none");
        expect(startup.models).toEqual([]);
    });

    test("no account means no models and no discovery", async () => {
        let fetched = false;
        const startup = await resolveStartupPiModelCatalog({
            cache: tempCache(),
            getAccount: () => undefined,
            fetchModels: async () => {
                fetched = true;
                return RESPONSE;
            },
        });
        expect(startup.source).toBe("none");
        expect(fetched).toBe(false);
    });
});

describe("openWebUiPiAuth factory", () => {
    test("registers cached models immediately and re-registers when the refresh differs", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const { pi, registrations } = fakePi();

        await openWebUiPiAuth(pi, {
            catalog: {
                cache,
                getAccount: () => ACCOUNT,
                fetchModels: async () => {
                    await gate;
                    return NEWER_RESPONSE;
                },
            },
        });

        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.name).toBe("openwebui");
        expect(registrations[0]?.models).toHaveLength(2);

        release();
        await new Promise((r) => setTimeout(r, 20));
        expect(registrations).toHaveLength(2);
        expect(registrations[1]?.models.map((m) => m.id)).toContain(
            "bedrock-claude-5-sonnet",
        );
    });

    test("does not re-register when the refresh returns the same catalog", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        const { pi, registrations } = fakePi();
        await openWebUiPiAuth(pi, {
            catalog: {
                cache,
                getAccount: () => ACCOUNT,
                fetchModels: async () => RESPONSE,
            },
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(registrations).toHaveLength(1);
    });

    test("a cold start registers the live catalog once", async () => {
        const { pi, registrations } = fakePi();
        await openWebUiPiAuth(pi, {
            catalog: {
                cache: tempCache(),
                getAccount: () => ACCOUNT,
                fetchModels: async () => RESPONSE,
            },
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.models).toHaveLength(2);
    });

    test("a rejected late re-registration is swallowed", async () => {
        const cache = tempCache();
        await seedCache(cache, STALE);
        let calls = 0;
        const pi = {
            registerProvider() {
                calls++;
                if (calls > 1) throw new Error("extension ctx is stale");
            },
        } as unknown as Parameters<typeof openWebUiPiAuth>[0];
        await openWebUiPiAuth(pi, {
            catalog: {
                cache,
                getAccount: () => ACCOUNT,
                fetchModels: async () => NEWER_RESPONSE,
            },
        });
        await new Promise((r) => setTimeout(r, 20));
        expect(calls).toBe(2);
    });
});
