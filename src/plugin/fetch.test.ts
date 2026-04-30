import { describe, expect, it } from "bun:test";
import {
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
        const textValues = [...json.matchAll(/"text":"((?:[^"\\]|\\.)*)"/g)].map(
            (m) => m[1],
        );
        for (const v of textValues) {
            expect(containsWhitespaceOnly(v)).toBe(false);
            expect(v).not.toBe("");
        }
    });
});
