import { afterEach, describe, expect, it } from "bun:test";
import {
    parseRetryAfterMs,
    sanitizeBedrockContent,
    sanitizeContentBlock,
    sanitizeMessageContent,
} from "./fetch";

const containsWhitespaceOnly = (text: unknown): boolean =>
    typeof text === "string" && text.length > 0 && text.trim() === "";

describe("sanitizeContentBlock", () => {
    it("replaces empty text with a non-whitespace placeholder", () => {
        const out = sanitizeContentBlock({ type: "text", text: "" }) as {
            text: string;
        };
        expect(out.text.trim()).not.toBe("");
    });

    it("replaces whitespace-only text with a non-whitespace placeholder", () => {
        for (const ws of [" ", "\t", "\n", "  \n\t  "]) {
            const out = sanitizeContentBlock({ type: "text", text: ws }) as {
                text: string;
            };
            expect(out.text.trim()).not.toBe("");
        }
    });

    it("leaves non-empty text blocks unchanged", () => {
        const block = { type: "text", text: "hello" };
        expect(sanitizeContentBlock(block)).toEqual(block);
    });

    it("recurses into tool_result.content arrays", () => {
        const out = sanitizeContentBlock({
            type: "tool_result",
            tool_use_id: "tu_123",
            content: [
                { type: "text", text: "" },
                { type: "text", text: "ok" },
            ],
        }) as { content: Array<{ type: string; text: string }> };
        expect(out.content).toHaveLength(2);
        expect(out.content[0].text.trim()).not.toBe("");
        expect(out.content[1].text).toBe("ok");
    });

    it("backfills empty tool_result.content with a placeholder block", () => {
        const out = sanitizeContentBlock({
            type: "tool_result",
            tool_use_id: "tu_123",
            content: [],
        }) as { content: Array<{ type: string; text: string }> };
        expect(out.content).toHaveLength(1);
        expect(out.content[0].type).toBe("text");
        expect(out.content[0].text.trim()).not.toBe("");
    });

    it("leaves non-text non-tool_result blocks alone", () => {
        const block = {
            type: "image_url",
            image_url: { url: "data:image/png;base64,..." },
        };
        expect(sanitizeContentBlock(block)).toEqual(block);
    });
});

describe("sanitizeMessageContent", () => {
    it("replaces empty string content with a non-whitespace placeholder", () => {
        const msg: { content: unknown } = { content: "" };
        sanitizeMessageContent(msg);
        expect(typeof msg.content === "string" && msg.content.trim()).not.toBe(
            "",
        );
    });

    it("replaces whitespace-only string content", () => {
        const msg: { content: unknown } = { content: "   \n\t  " };
        sanitizeMessageContent(msg);
        expect(typeof msg.content === "string" && msg.content.trim()).not.toBe(
            "",
        );
    });

    it("backfills empty array content with a placeholder text block", () => {
        const msg: { role: string; content: unknown } = {
            role: "user",
            content: [],
        };
        sanitizeMessageContent(msg);
        const arr = msg.content as Array<{ type: string; text: string }>;
        expect(arr).toHaveLength(1);
        expect(arr[0].type).toBe("text");
        expect(arr[0].text.trim()).not.toBe("");
    });

    it("sanitizes empty text blocks inside an array", () => {
        const msg: { content: unknown } = {
            content: [
                { type: "text", text: "" },
                { type: "text", text: "real" },
                { type: "text", text: "  " },
            ],
        };
        sanitizeMessageContent(msg);
        const arr = msg.content as Array<{ type: string; text: string }>;
        for (const block of arr) {
            expect(block.text.trim()).not.toBe("");
        }
    });

    it("leaves null content alone (valid for tool_calls-only assistant turn)", () => {
        const msg: { role: string; content: unknown; tool_calls: unknown } = {
            role: "assistant",
            content: null,
            tool_calls: [
                {
                    id: "call_1",
                    type: "function",
                    function: { name: "x", arguments: "{}" },
                },
            ],
        };
        sanitizeMessageContent(msg);
        expect(msg.content).toBeNull();
    });

    it("leaves undefined content alone", () => {
        const msg: { content?: unknown } = {};
        sanitizeMessageContent(msg);
        expect(msg.content).toBeUndefined();
    });

    it("never produces a whitespace-only placeholder anywhere in output", () => {
        const msg: { content: unknown } = {
            content: [
                { type: "text", text: "" },
                {
                    type: "tool_result",
                    tool_use_id: "x",
                    content: [{ type: "text", text: "" }],
                },
            ],
        };
        sanitizeMessageContent(msg);
        const json = JSON.stringify(msg);
        expect(json).not.toMatch(/"text":""/);
        expect(json).not.toMatch(/"text":" "/);
        expect(json).not.toMatch(/"text":"\\t"/);
        expect(json).not.toMatch(/"text":"\\n"/);
    });
});

describe("sanitizeBedrockContent", () => {
    it("sanitizes body.system when given as a ContentBlock array", () => {
        const body: { system: unknown; messages: unknown } = {
            system: [{ type: "text", text: "" }],
            messages: [],
        };
        sanitizeBedrockContent(body);
        const sys = body.system as Array<{ type: string; text: string }>;
        expect(sys[0].text.trim()).not.toBe("");
    });

    it("sanitizes body.system when given as a whitespace-only string", () => {
        const body: { system: unknown; messages: unknown } = {
            system: "   ",
            messages: [],
        };
        sanitizeBedrockContent(body);
        expect(typeof body.system === "string" && body.system.trim()).not.toBe(
            "",
        );
    });

    it("backfills an empty system array", () => {
        const body: { system: unknown } = { system: [] };
        sanitizeBedrockContent(body);
        const sys = body.system as Array<{ type: string; text: string }>;
        expect(sys).toHaveLength(1);
        expect(sys[0].text.trim()).not.toBe("");
    });

    it("leaves a non-empty string system alone", () => {
        const body: { system: unknown } = { system: "You are helpful." };
        sanitizeBedrockContent(body);
        expect(body.system).toBe("You are helpful.");
    });

    it("iterates and sanitizes all messages", () => {
        const body = {
            messages: [
                { role: "user", content: "" },
                {
                    role: "assistant",
                    content: [{ type: "text", text: "  " }],
                },
                { role: "tool", content: "" },
            ],
        };
        sanitizeBedrockContent(body);
        for (const msg of body.messages) {
            const c = msg.content;
            if (typeof c === "string") {
                expect(c.trim()).not.toBe("");
            } else if (Array.isArray(c)) {
                for (const b of c as Array<{ text?: string }>) {
                    if (typeof b.text === "string") {
                        expect(b.text.trim()).not.toBe("");
                    }
                }
            }
        }
    });

    it("is a no-op for non-object bodies", () => {
        expect(() => sanitizeBedrockContent(null)).not.toThrow();
        expect(() => sanitizeBedrockContent(undefined)).not.toThrow();
        expect(() => sanitizeBedrockContent("string")).not.toThrow();
    });

    it("never leaves a whitespace-only text anywhere in the body", () => {
        const body = {
            system: [{ type: "text", text: " " }],
            messages: [
                { role: "system", content: "" },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "" },
                        {
                            type: "tool_result",
                            tool_use_id: "x",
                            content: [{ type: "text", text: "\n" }],
                        },
                    ],
                },
            ],
        };
        sanitizeBedrockContent(body);
        const json = JSON.stringify(body);
        const textValues = [
            ...json.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g),
        ].map((m) => m[1]);
        for (const v of textValues) {
            expect(containsWhitespaceOnly(v)).toBe(false);
            expect(v).not.toBe("");
        }
    });
});

describe("parseRetryAfterMs", () => {
    const withHeader = (value: string | null): Response => {
        const headers = new Headers();
        if (value !== null) headers.set("retry-after", value);
        return new Response(null, { headers });
    };

    it("returns undefined when the header is absent", () => {
        expect(parseRetryAfterMs(withHeader(null))).toBeUndefined();
    });

    it("parses delta-seconds into milliseconds", () => {
        expect(parseRetryAfterMs(withHeader("0"))).toBe(0);
        expect(parseRetryAfterMs(withHeader("2"))).toBe(2000);
        expect(parseRetryAfterMs(withHeader("120"))).toBe(120000);
    });

    it("clamps negative delta-seconds to 0", () => {
        expect(parseRetryAfterMs(withHeader("-5"))).toBe(0);
    });

    it("parses an HTTP-date into a future delay", () => {
        const future = new Date(Date.now() + 5000).toUTCString();
        const ms = parseRetryAfterMs(withHeader(future));
        expect(ms).toBeGreaterThan(3000);
        expect(ms).toBeLessThanOrEqual(5000);
    });

    it("returns 0 for a past HTTP-date", () => {
        const past = new Date(Date.now() - 60000).toUTCString();
        expect(parseRetryAfterMs(withHeader(past))).toBe(0);
    });

    it("returns undefined for an unparseable value", () => {
        expect(parseRetryAfterMs(withHeader("soon"))).toBeUndefined();
    });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "@openwebui-auth/core";
import { makeOwuiFetch } from "./fetch";

function fakeJwt(expSeconds: number): string {
    const b64 = (value: object) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${b64({ alg: "HS256" })}.${b64({ id: "u1", exp: expSeconds })}.sig`;
}

async function withStore<T>(fn: (storage: Storage) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "owui-fetch-"));
    const storage = new Storage(join(dir, "accounts.json"));
    await storage.upsert({
        name: "test",
        baseUrl: "https://owui.invalid",
        token: fakeJwt(Math.floor(Date.now() / 1000) + 86_400),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    await storage.setCurrent("test");
    try {
        return await fn(storage);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

describe("owuiFetch chat/completions admission", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("regression: an HTML 200 from the SPA is converted into a JSON 502, not passed through", async () => {
        await withStore(async (storage) => {
            globalThis.fetch = (async () =>
                new Response("<!DOCTYPE html><html><body>login</body></html>", {
                    status: 200,
                    headers: { "content-type": "text/html; charset=utf-8" },
                })) as unknown as typeof fetch;
            const res = await makeOwuiFetch(storage)(
                "https://placeholder/v1/chat/completions",
                {
                    method: "POST",
                    body: JSON.stringify({
                        model: "m",
                        stream: true,
                        messages: [{ role: "user", content: "hi" }],
                    }),
                },
            );
            expect(res.status).toBe(502);
            const body = (await res.json()) as { error: { message: string } };
            expect(body.error.message).toContain("HTML page");
        });
    });

    it("regression: a thrown 'fetch failed' is retried once the socket comes back", async () => {
        process.env.OWUI_RETRY_BASE_MS = "1";
        await withStore(async (storage) => {
            let calls = 0;
            globalThis.fetch = (async () => {
                calls++;
                if (calls === 1) {
                    throw new TypeError("fetch failed", {
                        cause: Object.assign(new Error("read ECONNRESET"), {
                            code: "ECONNRESET",
                        }),
                    });
                }
                return new Response(JSON.stringify({ choices: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }) as unknown as typeof fetch;
            const res = await makeOwuiFetch(storage)(
                "https://placeholder/v1/chat/completions",
                {
                    method: "POST",
                    body: JSON.stringify({
                        model: "m",
                        messages: [{ role: "user", content: "hi" }],
                    }),
                },
            );
            expect(calls).toBe(2);
            expect(res.status).toBe(200);
        });
    });

    it("passes an event stream through unchanged while recording diagnostics", async () => {
        await withStore(async (storage) => {
            const sse =
                'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
            globalThis.fetch = (async () =>
                new Response(sse, {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                })) as unknown as typeof fetch;
            const res = await makeOwuiFetch(storage)(
                "https://placeholder/v1/chat/completions",
                {
                    method: "POST",
                    body: JSON.stringify({
                        model: "m",
                        stream: true,
                        messages: [{ role: "user", content: "hi" }],
                    }),
                },
            );
            expect(res.status).toBe(200);
            expect(await res.text()).toBe(sse);
        });
    });
});
