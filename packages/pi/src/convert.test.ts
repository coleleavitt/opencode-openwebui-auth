import { describe, expect, it } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import { buildOpenAIRequest } from "./convert";

function ctx(partial: Partial<Context>): Context {
    return { messages: [], ...partial } as Context;
}

describe("buildOpenAIRequest", () => {
    it("prepends the system prompt and streams with usage", () => {
        const req = buildOpenAIRequest(
            "bedrock-claude-4-5-haiku",
            ctx({
                systemPrompt: "be nice",
                messages: [
                    { role: "user", content: "hi", timestamp: 0 } as never,
                ],
            }),
        );
        expect(req.model).toBe("bedrock-claude-4-5-haiku");
        expect(req.stream).toBe(true);
        expect(req.stream_options.include_usage).toBe(true);
        expect(req.messages[0]).toEqual({ role: "system", content: "be nice" });
        expect(req.messages[1]).toEqual({ role: "user", content: "hi" });
    });

    it("converts an assistant tool call into OpenAI tool_calls", () => {
        const req = buildOpenAIRequest(
            "m",
            ctx({
                messages: [
                    {
                        role: "assistant",
                        content: [
                            {
                                type: "toolCall",
                                id: "call_1",
                                name: "read",
                                arguments: { path: "a.txt" },
                            },
                        ],
                        api: "openai",
                        provider: "openwebui",
                        model: "m",
                        usage: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            totalTokens: 0,
                            cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: 0,
                            },
                        },
                        stopReason: "toolUse",
                        timestamp: 0,
                    } as never,
                ],
            }),
        );
        const msg = req.messages[0] as {
            tool_calls: Array<{
                function: { name: string; arguments: string };
            }>;
        };
        expect(msg.tool_calls[0].function.name).toBe("read");
        expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({
            path: "a.txt",
        });
    });

    it("maps a tool result to an OpenAI tool message", () => {
        const req = buildOpenAIRequest(
            "m",
            ctx({
                messages: [
                    {
                        role: "toolResult",
                        toolCallId: "call_1",
                        toolName: "read",
                        content: [{ type: "text", text: "file body" }],
                    } as never,
                ],
            }),
        );
        expect(req.messages[0]).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            content: "file body",
        });
    });

    it("declares tools and omits reasoning_effort by default (OWUI/Bedrock rejects it)", () => {
        const req = buildOpenAIRequest(
            "m",
            ctx({
                messages: [
                    { role: "user", content: "x", timestamp: 0 } as never,
                ],
                tools: [
                    {
                        name: "read",
                        description: "read a file",
                        parameters: { type: "object", properties: {} } as never,
                    },
                ],
            }),
            { reasoning: "high", supportsReasoning: true },
        );
        expect(req.tools?.[0]).toMatchObject({
            type: "function",
            function: { name: "read" },
        });
        // Off unless OWUI_SEND_REASONING_EFFORT=1 — the deployment turns it into a
        // Bedrock `thinking` param that most models reject.
        expect(req.reasoning_effort).toBeUndefined();
    });

    it("sends reasoning_effort only when OWUI_SEND_REASONING_EFFORT=1", () => {
        const prev = process.env.OWUI_SEND_REASONING_EFFORT;
        process.env.OWUI_SEND_REASONING_EFFORT = "1";
        try {
            const req = buildOpenAIRequest(
                "m",
                ctx({
                    messages: [
                        { role: "user", content: "x", timestamp: 0 } as never,
                    ],
                }),
                { reasoning: "high", supportsReasoning: true },
            );
            expect(req.reasoning_effort).toBe("high");
        } finally {
            if (prev === undefined)
                delete process.env.OWUI_SEND_REASONING_EFFORT;
            else process.env.OWUI_SEND_REASONING_EFFORT = prev;
        }
    });

    it("sanitizes blank user content to a placeholder (Bedrock-safe)", () => {
        const req = buildOpenAIRequest(
            "m",
            ctx({
                messages: [
                    { role: "user", content: "   ", timestamp: 0 } as never,
                ],
            }),
        );
        expect(req.messages[0]).toEqual({ role: "user", content: "." });
    });
});
