#!/usr/bin/env bun
import { Storage } from "./storage";
import { fetchInstanceConfig, listModels, normalizeBaseUrl, verifyToken } from "./oauth/api";
import { parseJwtClaims } from "./oauth/jwt";
import { getOpencodeAuthPath, removeOpencodeProviderAuth, setOpencodeProviderAuth } from "./opencode-auth";
import type { OpenWebUIAccount } from "./types";

const PROVIDER_ID = "openwebui";
const DUMMY_KEY = "owui-plugin-managed";

function usage(): never {
    console.log(`opencode-openwebui-auth CLI

Commands:
  add <baseUrl> <token>     Add/update an OpenWebUI account
  list                      List configured accounts
  use <name>                Set the current account
  remove <name>             Delete an account
  models [name]             List models for the given (or current) account
  whoami                    Print the current account and verify token

Env:
  OWUI_BASE_URL             Default base URL when not provided
`);
    process.exit(1);
}

async function cmdAdd(args: string[]): Promise<void> {
    const baseUrlArg = args[0] ?? process.env.OWUI_BASE_URL;
    const token = args[1];
    if (!baseUrlArg || !token) usage();
    const baseUrl = normalizeBaseUrl(baseUrlArg);
    const claims = parseJwtClaims(token);
    if (!claims) throw new Error("Provided token is not a decodable JWT");
    const user = await verifyToken(baseUrl, token);
    const cfg = await fetchInstanceConfig(baseUrl).catch(() => null);
    const name = `${user.email}@${new URL(baseUrl).host}`;
    const account: OpenWebUIAccount = {
        name,
        baseUrl,
        token,
        expiresAt: claims.exp * 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    new Storage().upsert(account);
    setOpencodeProviderAuth(PROVIDER_ID, DUMMY_KEY);
    console.log(
        `added ${name}  (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"}, expires=${new Date(account.expiresAt!).toISOString()})`,
    );
    console.log(`wrote provider "${PROVIDER_ID}" -> ${getOpencodeAuthPath()}`);
}

function cmdList(): void {
    const accounts = new Storage().list();
    if (accounts.length === 0) {
        console.log("(no accounts)");
        return;
    }
    const current = new Storage().getCurrent()?.name;
    for (const a of accounts) {
        const star = a.name === current ? "*" : " ";
        const exp = a.expiresAt ? new Date(a.expiresAt).toISOString() : "?";
        console.log(`${star} ${a.name.padEnd(48)}  ${a.baseUrl}  expires=${exp}`);
    }
}

function cmdUse(args: string[]): void {
    const name = args[0];
    if (!name) usage();
    if (!new Storage().setCurrent(name)) throw new Error(`No account named ${name}`);
    console.log(`current -> ${name}`);
}

function cmdRemove(args: string[]): void {
    const name = args[0];
    if (!name) usage();
    new Storage().remove(name);
    if (new Storage().list().length === 0) {
        removeOpencodeProviderAuth(PROVIDER_ID);
    }
    console.log(`removed ${name}`);
}

async function cmdModels(args: string[]): Promise<void> {
    const storage = new Storage();
    const account = args[0] ? storage.list().find((a) => a.name === args[0]) : storage.getCurrent();
    if (!account) throw new Error("No such account");
    const models = await listModels(account.baseUrl, account.token);
    for (const m of models.data) {
        console.log(`${m.id.padEnd(48)}  ${m.name ?? ""}`);
    }
}

async function cmdWhoami(): Promise<void> {
    const account = new Storage().getCurrent();
    if (!account) {
        console.log("(no current account)");
        return;
    }
    const user = await verifyToken(account.baseUrl, account.token);
    console.log(`${account.name}\n  ${user.role} ${user.id} <${user.email}>`);
}

const [, , cmd, ...rest] = process.argv;
try {
    switch (cmd) {
        case "add":
            await cmdAdd(rest);
            break;
        case "list":
            cmdList();
            break;
        case "use":
            cmdUse(rest);
            break;
        case "remove":
            cmdRemove(rest);
            break;
        case "models":
            await cmdModels(rest);
            break;
        case "whoami":
            await cmdWhoami();
            break;
        default:
            usage();
    }
} catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
}
