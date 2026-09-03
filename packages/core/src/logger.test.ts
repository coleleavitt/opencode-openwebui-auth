import { afterEach, describe, expect, test } from "bun:test";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secureAppendLogFile } from "./logger";

const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "owui-logger-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

describe("secureAppendLogFile", () => {
    test("creates a user-only regular file and appends in order", () => {
        const file = join(tempDir(), "auth.log");

        expect(secureAppendLogFile(file, "first\n")).toBe(true);
        expect(secureAppendLogFile(file, "second\n")).toBe(true);

        expect(readFileSync(file, "utf8")).toBe("first\nsecond\n");
        expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test("tightens a log file left world-readable", () => {
        const file = join(tempDir(), "loose.log");
        writeFileSync(file, "old\n");
        chmodSync(file, 0o644);

        expect(secureAppendLogFile(file, "new\n")).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    test("refuses to follow a symlinked log path", () => {
        const dir = tempDir();
        const target = join(dir, "victim.txt");
        const link = join(dir, "auth.log");
        writeFileSync(target, "untouched\n");
        symlinkSync(target, link);

        expect(secureAppendLogFile(link, "attacker\n")).toBe(false);
        expect(readFileSync(target, "utf8")).toBe("untouched\n");
    });

    test("returns false rather than throwing on an unwritable path", () => {
        expect(
            secureAppendLogFile(join(tempDir(), "missing", "a.log"), "x"),
        ).toBe(false);
    });
});
