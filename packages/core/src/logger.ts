import {
    closeSync,
    fchmodSync,
    constants as fsConstants,
    fstatSync,
    mkdirSync,
    openSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Append to a user-private regular file without following a final-component
 * symlink. The log records account names, hosts, request URLs and error text,
 * so it must not be world-readable and must not be redirectable by a planted
 * link. Logging stays best-effort: an unsafe path or a filesystem failure
 * returns false rather than disturbing the request path.
 */
export function secureAppendLogFile(logFile: string, data: string): boolean {
    let fd: number | undefined;
    try {
        fd = openSync(
            logFile,
            fsConstants.O_APPEND |
                fsConstants.O_CREAT |
                fsConstants.O_WRONLY |
                fsConstants.O_NOFOLLOW,
            0o600,
        );
        if (!fstatSync(fd).isFile()) return false;
        fchmodSync(fd, 0o600);
        writeSync(fd, data);
        return true;
    } catch {
        return false;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {}
        }
    }
}

export function log(msg: string): void {
    init();
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    secureAppendLogFile(LOG_FILE, line);
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

export function getLogFilePath(): string {
    return LOG_FILE;
}

const ARTIFACT_DIR = join(LOG_DIR, "openwebui-auth", "logs");
const MAX_ARTIFACT_CHARS = 16 * 1024;

export function isDebugVerbose(): boolean {
    return process.env.OPENWEBUI_AUTH_DEBUG === "verbose";
}

/** One line per completion stream: outcome plus counters, never bodies. */
export function logStream(adapter: string, summary: string): void {
    log(`[stream:${adapter}] ${summary}`);
}

/**
 * Verbose-only raw artifact (e.g. the SSE body of a failed stream). Written to
 * a user-private file under the adapter log dir, bounded so a runaway stream
 * cannot fill the disk; the head and tail are kept because the failure frame
 * is almost always the last thing the proxy sent.
 */
export function logDebugArtifact(
    name: string,
    label: string,
    text: string,
): boolean {
    if (!isDebugVerbose()) return false;
    init();
    try {
        mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    } catch {}
    const body =
        text.length > MAX_ARTIFACT_CHARS
            ? `${text.slice(0, MAX_ARTIFACT_CHARS / 2)}\n…[${text.length - MAX_ARTIFACT_CHARS} chars elided]…\n${text.slice(-MAX_ARTIFACT_CHARS / 2)}`
            : text;
    const entry = `--- ${new Date().toISOString()} ${label}\n${body}\n`;
    return secureAppendLogFile(join(ARTIFACT_DIR, `${name}.log`), entry);
}
