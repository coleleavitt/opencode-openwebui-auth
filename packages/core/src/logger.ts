import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), ".config", "opencode");
const LOG_FILE = join(LOG_DIR, "openwebui-auth.log");
const DEBUG = process.env.OPENWEBUI_AUTH_DEBUG === "verbose";

let initialized = false;
function init() {
    if (initialized) return;
    try {
        mkdirSync(dirname(LOG_FILE), { recursive: true });
    } catch {}
    initialized = true;
}

export function log(msg: string): void {
    init();
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        appendFileSync(LOG_FILE, line);
    } catch {}
    if (DEBUG) {
        process.stderr.write(`[owui-auth] ${msg}\n`);
    }
}

export function logAuth(account: string, msg: string): void {
    log(`[auth] ${account}: ${msg}`);
}

export function logRequest(url: string, method: string): void {
    if (!DEBUG) return;
    log(`[fetch] ${method} ${url}`);
}

export function logResponse(url: string, status: number): void {
    if (!DEBUG) return;
    log(`[fetch] ${status} ${url}`);
}
