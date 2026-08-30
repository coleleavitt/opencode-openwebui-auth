#!/usr/bin/env bun
/**
 * sync-owui-token.ts — copy the live OpenWebUI session token from the Zen/Firefox
 * browser cookie jar into the shared account store, so the pi extension and the
 * opencode plugin use your existing (trusted) browser login. No password stored.
 *
 * Run whenever the stored token has expired but you're still logged in the browser:
 *   bun scripts/sync-owui-token.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, globSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOST = process.env.OWUI_HOST ?? "genai.arizona.edu";
const BASE_URL = process.env.OWUI_BASE_URL ?? `https://${HOST}`;
const STORE = join(homedir(), ".config", "opencode", "openwebui-accounts.json");

function findCookieDb(): string {
    for (const pat of ["/.zen/*/cookies.sqlite", "/.mozilla/firefox/*/cookies.sqlite"]) {
        const hits = globSync(join(homedir(), pat));
        if (hits.length) return hits.sort((a, b) => a.length - b.length)[0];
    }
    throw new Error("no Zen/Firefox cookies.sqlite found");
}

function readToken(): string {
    const db = findCookieDb();
    const out = execFileSync("sqlite3", [
        db,
        `SELECT value FROM moz_cookies WHERE host='${HOST}' AND name='token' LIMIT 1;`,
    ]).toString().trim();
    if (!out) throw new Error(`no 'token' cookie for ${HOST} — log in via the browser first`);
    return out;
}

function jwtExpMs(token: string): number {
    const seg = token.split(".")[1];
    const json = Buffer.from(seg, "base64url").toString("utf8");
    return JSON.parse(json).exp * 1000;
}

const token = readToken();
const expiresAt = jwtExpMs(token);
if (expiresAt <= Date.now()) throw new Error("browser token is itself expired — re-login in the browser");

const store = existsSync(STORE)
    ? JSON.parse(readFileSync(STORE, "utf8"))
    : { version: 1, accounts: {} };

const name = `${(process.env.OWUI_EMAIL ?? "user")}@${HOST}`;
// Update whichever account targets this host, else create one.
const match = Object.keys(store.accounts).find(
    (k) => store.accounts[k].baseUrl?.includes(HOST),
) ?? name;
const prev = store.accounts[match] ?? {};
store.accounts[match] = {
    name: match,
    baseUrl: BASE_URL,
    token,
    expiresAt,
    createdAt: prev.createdAt ?? Date.now(),
    updatedAt: Date.now(),
};
store.current = match;

mkdirSync(dirname(STORE), { recursive: true });
const tmp = `${STORE}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
renameSync(tmp, STORE);

console.log(`synced ${match}: token valid until ${new Date(expiresAt).toISOString()}`);
