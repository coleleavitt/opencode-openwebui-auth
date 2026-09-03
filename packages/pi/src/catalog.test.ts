import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCache, type OpenWebUIAccount } from "@openwebui-auth/core";

import { resolvePiModelCatalog } from "./index";

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
