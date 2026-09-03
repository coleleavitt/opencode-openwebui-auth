import { afterEach, describe, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelCatalogCache } from "./model-cache";

const dirs: string[] = [];

function tempCache(): string {
    const dir = mkdtempSync(join(tmpdir(), "owui-models-"));
    dirs.push(dir);
    return join(dir, "openwebui-models.json");
}

const MODELS = [{ id: "openai.gpt-5.6-sol" }, { id: "bedrock-claude-5-opus" }];

afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

describe("ModelCatalogCache", () => {
    test("round-trips a catalog for the same host, user-only", () => {
        const path = tempCache();
        const cache = new ModelCatalogCache<{ id: string }>(path);

        cache.save("https://owui.example", MODELS);

        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(cache.load("https://owui.example")?.models).toEqual(MODELS);
    });

    test("ignores a catalog cached for a different host", () => {
        const path = tempCache();
        const cache = new ModelCatalogCache<{ id: string }>(path);
        cache.save("https://owui.example", MODELS);
        expect(cache.load("https://other.example")).toBeUndefined();
    });

    test("an empty fetch never erases the last good catalog", () => {
        const path = tempCache();
        const cache = new ModelCatalogCache<{ id: string }>(path);
        cache.save("https://owui.example", MODELS);

        cache.save("https://owui.example", []);

        expect(cache.load("https://owui.example")?.models).toEqual(MODELS);
    });

    test("missing and corrupt caches read as absent instead of throwing", () => {
        const path = tempCache();
        const cache = new ModelCatalogCache<{ id: string }>(path);
        expect(cache.load("https://owui.example")).toBeUndefined();

        writeFileSync(path, "{not json");
        expect(cache.load("https://owui.example")).toBeUndefined();

        writeFileSync(
            path,
            JSON.stringify({
                version: 2,
                baseUrl: "https://owui.example",
                models: MODELS,
            }),
        );
        expect(cache.load("https://owui.example")).toBeUndefined();
    });

    test("records when the catalog was fetched", () => {
        const path = tempCache();
        const cache = new ModelCatalogCache<{ id: string }>(path);
        const before = Date.now();
        cache.save("https://owui.example", MODELS);
        const fetchedAt = cache.load("https://owui.example")?.fetchedAt ?? 0;
        expect(fetchedAt).toBeGreaterThanOrEqual(before);
        expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
    });
});
