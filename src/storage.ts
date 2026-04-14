import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OpenWebUIAccount, OpenWebUIStore } from "./types";
import { log } from "./logger";

const STORE_PATH = join(homedir(), ".config", "opencode", "openwebui-accounts.json");

const EMPTY: OpenWebUIStore = { version: 1, accounts: {} };

export class Storage {
    private path: string;

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
}
