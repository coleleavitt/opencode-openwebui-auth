import { afterEach, expect, test } from "bun:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

import { streamOpenWebUI } from "./stream";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

function sseResponse(lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            for (const line of lines)
                controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
    });
}

const MODEL = {
    id: "openai.gpt-5.6-sol",
    name: "GPT 5.6 Sol",
    api: "openai",
    provider: "openwebui",
    baseUrl: "https://example.invalid/api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
} as unknown as Model<Api>;

const CONTEXT: Context = {
    systemPrompt: "",
    messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
} as unknown as Context;

async function collect(lines: string[]) {
    globalThis.fetch = (async () =>
        sseResponse(lines)) as unknown as typeof fetch;
    const events: Array<{ type: string; delta?: string; content?: string }> =
        [];
    for await (const event of streamOpenWebUI(MODEL, CONTEXT, {
        apiKey: "test-token",
    })) {
        events.push(
            event as { type: string; delta?: string; content?: string },
        );
    }
    return events;
}

test("maps reasoning_content deltas onto pi thinking events before the answer", async () => {
    const events = await collect([
        JSON.stringify({
            choices: [
                { delta: { role: "assistant", reasoning_content: "17*23 " } },
            ],
        }),
        JSON.stringify({
            choices: [{ delta: { reasoning_content: "= 391" } }],
        }),
        JSON.stringify({ choices: [{ delta: { content: "391" } }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ]);

    const types = events.map((event) => event.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_delta");
    expect(types.indexOf("thinking_start")).toBeLessThan(
        types.indexOf("text_start"),
    );

    const thinkingEnd = events.find((event) => event.type === "thinking_end");
    expect(thinkingEnd?.content).toBe("17*23 = 391");

    const textEnd = events.find((event) => event.type === "text_end");
    expect(textEnd?.content).toBe("391");
});

test("reads the reasoning and reasoning_text spellings too", async () => {
    const reasoning = await collect([
        JSON.stringify({
            choices: [{ delta: { reasoning: "via reasoning" } }],
        }),
        JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        }),
    ]);
    expect(
        reasoning.find((event) => event.type === "thinking_end")?.content,
    ).toBe("via reasoning");

    const reasoningText = await collect([
        JSON.stringify({
            choices: [{ delta: { reasoning_text: "via reasoning_text" } }],
        }),
        JSON.stringify({
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        }),
    ]);
    expect(
        reasoningText.find((event) => event.type === "thinking_end")?.content,
    ).toBe("via reasoning_text");
});

test("emits no thinking block when the deployment returns empty or redacted reasoning", async () => {
    const events = await collect([
        JSON.stringify({
            choices: [
                {
                    delta: {
                        reasoning_content: "",
                        thinking_blocks: [
                            { type: "redacted_thinking", data: "opaque" },
                        ],
                    },
                },
            ],
        }),
        JSON.stringify({
            choices: [{ delta: { content: "391" }, finish_reason: "stop" }],
        }),
    ]);

    expect(events.map((event) => event.type)).not.toContain("thinking_start");
    expect(events.find((event) => event.type === "text_end")?.content).toBe(
        "391",
    );
});
