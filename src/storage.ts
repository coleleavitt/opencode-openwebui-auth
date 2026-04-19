import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OpenWebUIAccount, OpenWebUIStore, PerModelUsage } from "./types";
import { log } from "./logger";
import { computeUsageCost, getModelPricing, normalizeModelKey } from "./pricing";

const STORE_PATH = join(homedir(), ".config", "opencode", "openwebui-accounts.json");

const EMPTY: OpenWebUIStore = { version: 1, accounts: {} };

export class Storage {
    private path: string;
    private writeChain: Promise<void> = Promise.resolve();

    constructor(path: string = STORE_PATH) {
        this.path = path;
    }

    load(): OpenWebUIStore {
        try {
            if (!existsSync(this.path)) return { ...EMPTY, accounts: {} };
            const raw = readFileSync(this.path, "utf8");
            const parsed = JSON.parse(raw) as OpenWebUIStore;
            if (parsed.version !== 1 || typeof parsed.accounts !== "object") {
                log(`[storage] malformed store at ${this.path}, using empty`);
                return { ...EMPTY, accounts: {} };
            }
            return parsed;
        } catch (err) {
            log(`[storage] load failed: ${err instanceof Error ? err.message : err}`);
            return { ...EMPTY, accounts: {} };
        }
    }

    save(store: OpenWebUIStore): void {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
            renameSync(tmp, this.path);
        } catch (err) {
            log(`[storage] save failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        }
    }

    upsert(account: OpenWebUIAccount): void {
        const store = this.load();
        store.accounts[account.name] = account;
        if (!store.current) store.current = account.name;
        this.save(store);
    }

    remove(name: string): void {
        const store = this.load();
        delete store.accounts[name];
        if (store.current === name) {
            const first = Object.keys(store.accounts)[0];
            store.current = first;
        }
        this.save(store);
    }

    setCurrent(name: string): boolean {
        const store = this.load();
        if (!store.accounts[name]) return false;
        store.current = name;
        this.save(store);
        return true;
    }

    getCurrent(): OpenWebUIAccount | undefined {
        const store = this.load();
        if (store.current && store.accounts[store.current]) {
            return store.accounts[store.current];
        }
        const first = Object.values(store.accounts).find((a) => !a.disabled);
        return first;
    }

    list(): OpenWebUIAccount[] {
        return Object.values(this.load().accounts);
    }

    async addUsage(
        accountName: string,
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; model?: string },
    ): Promise<void> {
        const op = this.writeChain.then(() => {
            const store = this.load();
            const account = store.accounts[accountName];
            if (!account) return;

            const today = new Date().toISOString().slice(0, 10);
            const pricing = getModelPricing(usage.model);
            const costUsd = computeUsageCost(usage, pricing);
            const modelKey = normalizeModelKey(usage.model);

            if (!account.dailyUsage || account.dailyUsage.date !== today) {
                account.dailyUsage = {
                    date: today,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    requestCount: 0,
                };
            }
            account.dailyUsage.inputTokens += usage.input;
            account.dailyUsage.outputTokens += usage.output;
            account.dailyUsage.cacheReadTokens += usage.cacheRead;
            account.dailyUsage.cacheWriteTokens += usage.cacheWrite;
            account.dailyUsage.requestCount += 1;

            if (!account.totalUsage) {
                account.totalUsage = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    requestCount: 0,
                    costUsd: 0,
                    firstSeen: today,
                };
            }
            account.totalUsage.inputTokens += usage.input;
            account.totalUsage.outputTokens += usage.output;
            account.totalUsage.cacheReadTokens += usage.cacheRead;
            account.totalUsage.cacheWriteTokens += usage.cacheWrite;
            account.totalUsage.requestCount += 1;
            account.totalUsage.costUsd = roundCost(account.totalUsage.costUsd + costUsd);

            if (!account.totalUsage.byModel) {
                account.totalUsage.byModel = {};
            }
            const perModel: PerModelUsage = account.totalUsage.byModel[modelKey] ?? {
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                requestCount: 0,
                costUsd: 0,
                firstSeen: today,
                lastSeen: today,
            };
            perModel.inputTokens += usage.input;
            perModel.outputTokens += usage.output;
            perModel.cacheReadTokens += usage.cacheRead;
            perModel.cacheWriteTokens += usage.cacheWrite;
            perModel.requestCount += 1;
            perModel.costUsd = roundCost(perModel.costUsd + costUsd);
            perModel.lastSeen = today;
            account.totalUsage.byModel[modelKey] = perModel;

            this.save(store);
        }).catch((e) => {
            log(`[storage] addUsage failed: ${e instanceof Error ? e.message : e}`);
        });
        this.writeChain = op;
        return op;
    }
}

function roundCost(value: number): number {
    return Math.round(value * 1e6) / 1e6;
}

export function getCombinedTotalUsage(accounts: OpenWebUIAccount[]): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    requestCount: number;
    costUsd: number;
    byModel: Record<string, PerModelUsage>;
} {
    const combined = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requestCount: 0,
        costUsd: 0,
        byModel: {} as Record<string, PerModelUsage>,
    };

    for (const account of accounts) {
        const t = account.totalUsage;
        if (!t) continue;
        combined.inputTokens += t.inputTokens;
        combined.outputTokens += t.outputTokens;
        combined.cacheReadTokens += t.cacheReadTokens;
        combined.cacheWriteTokens += t.cacheWriteTokens;
        combined.requestCount += t.requestCount;
        combined.costUsd = roundCost(combined.costUsd + t.costUsd);

        if (t.byModel) {
            for (const [key, pm] of Object.entries(t.byModel)) {
                const existing = combined.byModel[key];
                if (existing) {
                    existing.inputTokens += pm.inputTokens;
                    existing.outputTokens += pm.outputTokens;
                    existing.cacheReadTokens += pm.cacheReadTokens;
                    existing.cacheWriteTokens += pm.cacheWriteTokens;
                    existing.requestCount += pm.requestCount;
                    existing.costUsd = roundCost(existing.costUsd + pm.costUsd);
                    if (pm.firstSeen < existing.firstSeen) existing.firstSeen = pm.firstSeen;
                    if (pm.lastSeen > existing.lastSeen) existing.lastSeen = pm.lastSeen;
                } else {
                    combined.byModel[key] = { ...pm };
                }
            }
        }
    }

    return combined;
}
