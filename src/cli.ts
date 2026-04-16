#!/usr/bin/env bun
import { Storage } from "./storage";
import { fetchInstanceConfig, listModels, normalizeBaseUrl, verifyToken } from "./oauth/api";
import { parseJwtClaims } from "./oauth/jwt";
import { oidcLogin } from "./oauth/oidc-login";
import type { OpenWebUIAccount } from "./types";

function usage(): never {
    console.log(`opencode-openwebui-auth CLI

Commands:
  login [baseUrl]                       Automated OIDC login (Shibboleth + Duo 2FA)
  add <baseUrl> <token>                 Add/update an OpenWebUI account (manual JWT paste)
  list                                  List configured accounts
  use <name>                            Set the current account
  remove <name>                         Delete an account
  models [name] [--verbose|-v|--json]   List models for the given (or current) account
  config [name]                         Show OpenWebUI instance config (name, version, features)
  whoami                                Print the current account and verify token

Env:
  OWUI_BASE_URL             Default base URL (default: https://chat.ai2s.org)
  OWUI_USERNAME             NetID for automated login
  OWUI_PASSWORD             NetID password for automated login
  OWUI_DUO_PASSCODE         6-digit Duo Mobile passcode (optional, uses push if not set)
`);
    process.exit(1);
}

async function cmdLogin(args: string[]): Promise<void> {
    const baseUrl = normalizeBaseUrl(args[0] ?? process.env.OWUI_BASE_URL ?? "https://chat.ai2s.org");
    const username = process.env.OWUI_USERNAME;
    const password = process.env.OWUI_PASSWORD;
    const duoPasscode = process.env.OWUI_DUO_PASSCODE;

    if (!username || !password) {
        throw new Error("Set OWUI_USERNAME and OWUI_PASSWORD environment variables");
    }

    console.log(`logging in to ${baseUrl} as ${username}...`);
    const method = duoPasscode ? "passcode" : "push";
    if (method === "push") {
        console.log("no OWUI_DUO_PASSCODE set — will send Duo Push (approve on your phone)");
    }

    const result = await oidcLogin({
        baseUrl,
        username,
        password,
        duoPasscode,
        duoMethod: method,
    });

    const user = await verifyToken(baseUrl, result.token);
    const cfg = await fetchInstanceConfig(baseUrl).catch(() => null);
    const name = `${user.email}@${new URL(baseUrl).host}`;
    const account: OpenWebUIAccount = {
        name,
        baseUrl,
        token: result.token,
        expiresAt: result.expiresAt,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    new Storage().upsert(account);
    console.log(
        `\nlogged in as ${user.name} <${user.email}> (${user.role})`,
    );
    console.log(`instance: ${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"}`);
    console.log(`token expires: ${new Date(result.expiresAt).toISOString()}`);
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
    console.log(
        `added ${name}  (instance=${cfg?.name ?? "unknown"} v${cfg?.version ?? "?"}, expires=${new Date(account.expiresAt!).toISOString()})`,
    );
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
    console.log(`removed ${name}`);
}

async function cmdModels(args: string[]): Promise<void> {
    const flags = new Set(args.filter((a) => a.startsWith("-")));
    const positional = args.filter((a) => !a.startsWith("-"));

    const storage = new Storage();
    const account = positional[0]
        ? storage.list().find((a) => a.name === positional[0])
        : storage.getCurrent();
    if (!account) throw new Error("No such account");

    const models = await listModels(account.baseUrl, account.token);

    if (flags.has("--json")) {
        console.log(JSON.stringify(models, null, 2));
        return;
    }

    const capFlags = (caps: Record<string, boolean | undefined> | undefined): string => {
        if (!caps) return "";
        const flag = (k: string, c: string) => (caps[k] ? c : "·");
        return [
            flag("vision", "V"),
            flag("file_upload", "F"),
            flag("web_search", "W"),
            flag("code_interpreter", "C"),
            flag("builtin_tools", "T"),
            flag("citations", "Q"),
            flag("usage", "U"),
        ].join("");
    };

    if (flags.has("--verbose") || flags.has("-v")) {
        console.log("LEGEND: V=vision F=file W=web-search C=code-interp T=tools Q=citations U=usage  (· = off)");
        console.log();
        console.log(`${"ID".padEnd(46)}  ${"OWNER".padEnd(10)}  ${"CONN".padEnd(8)}  CAPS     NAME`);
        console.log("─".repeat(120));
        for (const m of models.data) {
            const caps = capFlags(m.info?.meta?.capabilities);
            const owner = (m.owned_by ?? "?").padEnd(10).slice(0, 10);
            const conn = (m.connection_type ?? "?").padEnd(8).slice(0, 8);
            console.log(`${m.id.padEnd(46)}  ${owner}  ${conn}  ${caps}  ${m.name ?? ""}`);
        }
        console.log();
        console.log(`${models.data.length} model(s) accessible to ${account.name}`);
    } else {
        for (const m of models.data) {
            console.log(`${m.id.padEnd(48)}  ${m.name ?? ""}`);
        }
    }
}

async function cmdConfig(args: string[]): Promise<void> {
    const storage = new Storage();
    const account = args[0] ? storage.list().find((a) => a.name === args[0]) : storage.getCurrent();
    const baseUrl = account?.baseUrl ?? process.env.OWUI_BASE_URL ?? "https://chat.ai2s.org";
    const cfg = await fetchInstanceConfig(baseUrl);
    const enabledFeatures = Object.entries(cfg.features ?? {})
        .filter(([, v]) => v)
        .map(([k]) => k);
    console.log(`instance:  ${cfg.name} v${cfg.version}`);
    console.log(`baseUrl:   ${baseUrl}`);
    console.log(`status:    ${cfg.status ? "online" : "offline"}`);
    console.log(`features:  ${enabledFeatures.join(", ") || "(none enabled)"}`);
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
        case "login":
            await cmdLogin(rest);
            break;
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
        case "config":
            await cmdConfig(rest);
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
