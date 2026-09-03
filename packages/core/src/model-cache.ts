import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { log } from "./logger";

/**
 * Last-known-good model catalog.
 *
 * Model discovery is a network call made while the agent is starting. When it
 * fails the provider used to register with zero models, so every OpenWebUI
 * model silently vanished from the picker with no error shown. Persisting the
 * previous catalog turns an outage into stale-but-usable model list.
 */
const CACHE_PATH = join(
    homedir(),
    ".config",
    "opencode",
    "openwebui-models.json",
);

interface CacheFile<T> {
    version: 1;
    baseUrl: string;
    fetchedAt: number;
    models: T[];
}

export class ModelCatalogCache<T = unknown> {
    private path: string;

    constructor(path: string = CACHE_PATH) {
        this.path = path;
    }

    /** Cached models for `baseUrl`, or undefined when absent or from another host. */
    load(baseUrl: string): { models: T[]; fetchedAt: number } | undefined {
        try {
            if (!existsSync(this.path)) return undefined;
            const parsed = JSON.parse(
                readFileSync(this.path, "utf8"),
            ) as CacheFile<T>;
            if (parsed.version !== 1 || !Array.isArray(parsed.models))
                return undefined;
            if (parsed.baseUrl !== baseUrl) return undefined;
            if (parsed.models.length === 0) return undefined;
            return { models: parsed.models, fetchedAt: parsed.fetchedAt };
        } catch (err) {
            log(
                `[models] cache load failed: ${err instanceof Error ? err.message : err}`,
            );
            return undefined;
        }
    }

    /** Replace the cache. An empty list is ignored so a failed fetch cannot erase it. */
    save(baseUrl: string, models: T[]): void {
        if (models.length === 0) return;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const payload: CacheFile<T> = {
                version: 1,
                baseUrl,
                fetchedAt: Date.now(),
                models,
            };
            const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, JSON.stringify(payload, null, 2), {
                mode: 0o600,
            });
            renameSync(tmp, this.path);
        } catch (err) {
            log(
                `[models] cache save failed: ${err instanceof Error ? err.message : err}`,
            );
        }
    }
}

export function getModelCachePath(): string {
    return CACHE_PATH;
}
