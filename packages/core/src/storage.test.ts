import { afterEach, describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireStoreLock, Storage } from "./storage";
import type { OpenWebUIAccount } from "./types";

const dirs: string[] = [];

const WORKERS = 6;
const WRITES_PER_WORKER = 4;

function tempStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "owui-store-"));
    dirs.push(dir);
    return join(dir, "openwebui-accounts.json");
}

function account(
    name: string,
    overrides: Partial<OpenWebUIAccount> = {},
): OpenWebUIAccount {
    return {
        name,
        baseUrl: "https://owui.example",
        token: "jwt",
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

describe("Storage persistence", () => {
    test("writes the store user-only", async () => {
        const path = tempStore();
        await new Storage(path).upsert(account("a@host"));
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    test("a token rotation keeps the accumulated usage", async () => {
        const path = tempStore();
        const storage = new Storage(path);
        await storage.upsert(account("a@host"));
        await storage.addUsage("a@host", {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            model: "bedrock-claude-5-opus",
        });

        const before = storage.getCurrent();
        expect(before).toBeDefined();
        if (!before) throw new Error("account missing");
        await storage.upsert({ ...before, token: "rotated", updatedAt: 2 });

        const after = storage.getCurrent();
        expect(after?.token).toBe("rotated");
        expect(after?.totalUsage?.inputTokens).toBe(1_000_000);
        expect(after?.totalUsage?.costUsd).toBe(15);
    });

    test("concurrent processes do not lose each other's usage", async () => {
        const path = tempStore();
        await new Storage(path).upsert(account("a@host"));

        // Real subprocesses, not two objects in one event loop: an in-process
        // promise chain already serializes a synchronous read-modify-write, so
        // only separate processes can exercise the cross-process lock.
        const storageModule = new URL("./storage.ts", import.meta.url).href;
        const worker = (index: number) =>
            `
            const { Storage } = await import(${JSON.stringify(storageModule)});
            const storage = new Storage(${JSON.stringify(path)});
            for (let i = 0; i < ${WRITES_PER_WORKER}; i++) {
                await storage.addUsage("a@host", {
                    input: 10, output: 5, cacheRead: 0, cacheWrite: 0,
                    model: "bedrock-claude-5-opus",
                });
            }
        `.replace("__INDEX__", String(index));

        const runs = Array.from(
            { length: WORKERS },
            (_, i) =>
                Bun.spawn(["bun", "-e", worker(i)], {
                    stdout: "pipe",
                    stderr: "pipe",
                }).exited,
        );
        expect(await Promise.all(runs)).toEqual(
            Array.from({ length: WORKERS }, () => 0),
        );

        const total = new Storage(path).getCurrent()?.totalUsage;
        expect(total?.requestCount).toBe(WORKERS * WRITES_PER_WORKER);
        expect(total?.inputTokens).toBe(WORKERS * WRITES_PER_WORKER * 10);
        expect(total?.outputTokens).toBe(WORKERS * WRITES_PER_WORKER * 5);
    }, 60_000);

    test("an unpriced model still records tokens, at zero cost", async () => {
        const path = tempStore();
        const storage = new Storage(path);
        await storage.upsert(account("a@host"));
        await storage.addUsage("a@host", {
            input: 1_000_000,
            output: 1_000_000,
            cacheRead: 0,
            cacheWrite: 0,
            model: "some-unlisted-model-v9",
        });

        const total = storage.getCurrent()?.totalUsage;
        expect(total?.inputTokens).toBe(1_000_000);
        expect(total?.costUsd).toBe(0);
        expect(total?.byModel?.["some-unlisted-model-v9"]?.requestCount).toBe(
            1,
        );
    });
});

describe("acquireStoreLock", () => {
    test("excludes a second holder until the first releases", async () => {
        const path = tempStore();
        const lock = `${path}.lock`;

        const release = await acquireStoreLock(lock);
        let acquired = false;
        const second = acquireStoreLock(lock).then((r) => {
            acquired = true;
            return r;
        });

        await new Promise((r) => setTimeout(r, 50));
        expect(acquired).toBe(false);

        release();
        (await second)();
        expect(acquired).toBe(true);
    });

    test("breaks a stale lock left by a dead process", async () => {
        const path = tempStore();
        const lock = `${path}.lock`;
        mkdirSync(lock);
        // Backdate past the staleness window.
        const old = Date.now() - 60_000;
        writeFileSync(join(lock, "marker"), "");
        rmSync(join(lock, "marker"));
        const { utimesSync } = await import("node:fs");
        utimesSync(lock, new Date(old), new Date(old));

        const release = await acquireStoreLock(lock);
        release();
        expect(true).toBe(true);
    });

    test("does not corrupt the store when a writer crashes mid-cycle", async () => {
        const path = tempStore();
        const storage = new Storage(path);
        await storage.upsert(account("a@host"));

        await expect(
            // @ts-expect-error deliberately breaking the store shape at runtime
            storage.upsert(null),
        ).rejects.toBeDefined();

        const raw = JSON.parse(readFileSync(path, "utf8"));
        expect(raw.accounts["a@host"].token).toBe("jwt");
    });
});
