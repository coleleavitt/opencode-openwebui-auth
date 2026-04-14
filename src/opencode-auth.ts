import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");

type OpencodeAuthEntry =
    | { type: "api"; key: string }
    | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string };

function loadAuth(): Record<string, OpencodeAuthEntry> {
    if (!existsSync(AUTH_PATH)) return {};
    try {
        return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, OpencodeAuthEntry>;
    } catch {
        return {};
    }
}

function saveAuth(data: Record<string, OpencodeAuthEntry>): void {
    mkdirSync(dirname(AUTH_PATH), { recursive: true });
    const tmp = `${AUTH_PATH}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, AUTH_PATH);
}

export function setOpencodeProviderAuth(providerId: string, key: string): void {
    const data = loadAuth();
    data[providerId] = { type: "api", key };
    saveAuth(data);
}

export function removeOpencodeProviderAuth(providerId: string): void {
    const data = loadAuth();
    delete data[providerId];
    saveAuth(data);
}

export function getOpencodeAuthPath(): string {
    return AUTH_PATH;
}
