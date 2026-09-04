import { afterEach, expect, test } from "bun:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

import { streamOpenWebUI } from "./stream";

const realFetch = globalThis.fetch;
const realRetryBase = process.env.OWUI_RETRY_BASE_MS;
process.env.OWUI_RETRY_BASE_MS = "1";
afterEach(() => {
    globalThis.fetch = realFetch;
    if (realRetryBase === undefined) process.env.OWUI_RETRY_BASE_MS = "1";
    else process.env.OWUI_RETRY_BASE_MS = realRetryBase;
});

function rawResponse(
    text: string,
    contentType = "text/event-stream",
    status = 200,
): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
    return new Response(body, {
        status,
        headers: { "content-type": contentType },
    });
}

function sseResponse(lines: string[], withDone = true): Response {
    const frames = lines.map((line) => `data: ${line}\n\n`);
    if (withDone) frames.push("data: [DONE]\n\n");
    return rawResponse(frames.join(""));
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

interface Captured {
    type: string;
    delta?: string;
    content?: string;
    reason?: string;
    error?: { errorMessage?: string; stopReason?: string };
    message?: {
        content: unknown[];
        stopReason: string;
        usage: { totalTokens: number };
    };
}

/** Serve one canned response per call; the last one repeats. */
function serve(responses: Array<() => Response>): { calls: () => number } {
    let calls = 0;
    globalThis.fetch = (async () => {
        const factory = responses[Math.min(calls, responses.length - 1)];
        calls++;
        return factory();
    }) as unknown as typeof fetch;
    return { calls: () => calls };
}

async function collectFrom(responses: Array<() => Response>) {
    const served = serve(responses);
    const events: Captured[] = [];
    for await (const event of streamOpenWebUI(MODEL, CONTEXT, {
        apiKey: "test-token",
    })) {
        events.push(event as unknown as Captured);
    }
    return { events, calls: served.calls() };
}

async function collect(lines: string[]) {
    return (await collectFrom([() => sseResponse(lines)])).events;
}

const LITELLM_ERROR_FRAME = JSON.stringify({
    error: {
        message:
            "litellm.ServiceUnavailableError: BedrockException - serviceUnavailableException",
        type: "None",
        param: "None",
        code: "503",
    },
});

const OK_STREAM = [
    JSON.stringify({
        choices: [{ delta: { role: "assistant", content: "OK" } }],
    }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
    }),
];

function last(events: Captured[]): Captured {
    return events[events.length - 1];
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

test("regression: a LiteLLM error frame is a terminal error, never an empty success", async () => {
    // LiteLLM's proxy reports post-start failures as `data: {"error": ...}`
    // with no [DONE]. The previous parser dropped choice-less frames and
    // settled the stream as content=[] / stop / usage=0 (the incident shape).
    const { events, calls } = await collectFrom([
        () => sseResponse([LITELLM_ERROR_FRAME], false),
    ]);
    const final = last(events);
    expect(final.type).toBe("error");
    expect(final.error?.stopReason).toBe("error");
    expect(final.error?.errorMessage).toContain("serviceUnavailableException");
    expect(events.map((event) => event.type)).not.toContain("done");
    // 503-coded frames are transient: one initial call plus MAX_RETRIES.
    expect(calls).toBe(3);
});

test("regression: a non-retryable error frame fails after a single request", async () => {
    const { events, calls } = await collectFrom([
        () =>
            sseResponse(
                [
                    JSON.stringify({
                        error: {
                            message: "Invalid tool schema",
                            type: "invalid_request_error",
                            code: 400,
                        },
                    }),
                ],
                false,
            ),
    ]);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("Invalid tool schema");
    expect(calls).toBe(1);
});

test("regression: a [DONE]-only stream is an empty completion, retried then failed", async () => {
    const { events, calls } = await collectFrom([() => sseResponse([])]);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("empty completion");
    expect(calls).toBe(3);
    // Exactly one `start`; the consumer never sees a phantom second turn.
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
});

test("regression: a body that ends without [DONE] or finish_reason is truncated, not stop", async () => {
    const { events, calls } = await collectFrom([() => rawResponse("")]);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("terminal frame");
    expect(calls).toBe(3);
});

test("a transient stream failure followed by a good stream yields one clean completion", async () => {
    const { events, calls } = await collectFrom([
        () => sseResponse([LITELLM_ERROR_FRAME], false),
        () => sseResponse(OK_STREAM),
    ]);
    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.find((event) => event.type === "text_end")?.content).toBe(
        "OK",
    );
    const done = last(events);
    expect(done.type).toBe("done");
    expect(done.message?.stopReason).toBe("stop");
    expect(done.message?.usage.totalTokens).toBe(16);
});

test("an error frame after content was emitted fails without a retry", async () => {
    const { events, calls } = await collectFrom([
        () =>
            sseResponse(
                [
                    JSON.stringify({
                        choices: [{ delta: { content: "partial" } }],
                    }),
                    LITELLM_ERROR_FRAME,
                ],
                false,
            ),
    ]);
    expect(calls).toBe(1);
    expect(events.find((event) => event.type === "text_delta")?.delta).toBe(
        "partial",
    );
    expect(last(events).type).toBe("error");
});

test("a stream cut off mid-answer is reported as truncated, not settled as stop", async () => {
    const { events, calls } = await collectFrom([
        () =>
            sseResponse(
                [JSON.stringify({ choices: [{ delta: { content: "half" } }] })],
                false,
            ),
    ]);
    expect(calls).toBe(1);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("cut off after 4");
});

test("finish_reason=content_filter is surfaced as an error", async () => {
    const { events } = await collectFrom([
        () =>
            sseResponse([
                JSON.stringify({
                    choices: [
                        {
                            delta: { content: "x" },
                            finish_reason: "content_filter",
                        },
                    ],
                }),
            ]),
    ]);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("content_filter");
});

test("an HTML 200 (SPA/login page) is rejected instead of parsed as an empty stream", async () => {
    const { events, calls } = await collectFrom([
        () =>
            rawResponse(
                "<!DOCTYPE html><html><head><title>Open WebUI</title></head></html>",
                "text/html; charset=utf-8",
            ),
    ]);
    expect(calls).toBe(1);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("HTML page");
});

test("a non-streamed JSON completion is mapped onto text + usage", async () => {
    const { events } = await collectFrom([
        () =>
            rawResponse(
                JSON.stringify({
                    choices: [
                        {
                            message: { role: "assistant", content: "json ok" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: { prompt_tokens: 3, completion_tokens: 2 },
                }),
                "application/json",
            ),
    ]);
    expect(events.find((event) => event.type === "text_end")?.content).toBe(
        "json ok",
    );
    expect(last(events).type).toBe("done");
    expect(last(events).message?.usage.totalTokens).toBe(5);
});

test("a JSON error body on a 200 is an error, not an empty completion", async () => {
    const { events, calls } = await collectFrom([
        () =>
            rawResponse(
                JSON.stringify({ detail: "Model not found" }),
                "application/json",
            ),
    ]);
    expect(calls).toBe(1);
    expect(last(events).type).toBe("error");
    expect(last(events).error?.errorMessage).toContain("Model not found");
});

test("tool-call-only streams settle as toolUse, not empty", async () => {
    const { events } = await collectFrom([
        () =>
            sseResponse([
                JSON.stringify({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: "call_1",
                                        function: {
                                            name: "read",
                                            arguments: '{"path":',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
                JSON.stringify({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        function: { arguments: '"a"}' },
                                    },
                                ],
                            },
                            finish_reason: "tool_calls",
                        },
                    ],
                }),
            ]),
    ]);
    const done = last(events);
    expect(done.type).toBe("done");
    expect(done.reason).toBe("toolUse");
    const call = done.message?.content[0] as {
        name: string;
        arguments: unknown;
    };
    expect(call.name).toBe("read");
    expect(call.arguments).toEqual({ path: "a" });
});
