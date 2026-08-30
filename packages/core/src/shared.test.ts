import { describe, expect, it } from "bun:test";
import {
    backoffDelayMs,
    inferModelLimits,
    isRetryableErrorBody,
    MAX_RETRY_AFTER_MS,
    messagesReferenceTools,
    nextRetryDelayMs,
    parseRetryAfterMs,
    parseUsageFromBuffer,
    sanitizeBedrockContent,
    scrubBedrockToolFields,
    shapeBedrockRequestBody,
} from "./index";

const resWith = (status: number, headers: Record<string, string> = {}) =>
    ({ status, headers: new Headers(headers) }) as unknown as {
        status: number;
        headers: { get(n: string): string | null };
    };

describe("parseRetryAfterMs", () => {
    it("parses delta-seconds", () => {
        expect(parseRetryAfterMs(resWith(429, { "retry-after": "2" }))).toBe(2000);
    });
    it("returns undefined when absent", () => {
        expect(parseRetryAfterMs(resWith(429))).toBeUndefined();
    });
    it("clamps negatives to 0", () => {
        expect(parseRetryAfterMs(resWith(429, { "retry-after": "-3" }))).toBe(0);
    });
});

describe("nextRetryDelayMs", () => {
    it("honors Retry-After on 429, clamped", () => {
        const d = nextRetryDelayMs(resWith(429, { "retry-after": "9999" }), 1);
        expect(d).toBe(MAX_RETRY_AFTER_MS);
    });
    it("backoff on 503", () => {
        const d = nextRetryDelayMs(resWith(503), 1);
        expect(d).toBeGreaterThan(0);
    });
    it("undefined on non-retryable 400", () => {
        expect(nextRetryDelayMs(resWith(400), 1)).toBeUndefined();
    });
    it("respects x-should-retry:false override", () => {
        expect(nextRetryDelayMs(resWith(503), 1, "false")).toBeUndefined();
    });
    it("respects x-should-retry:true override", () => {
        expect(nextRetryDelayMs(resWith(418), 1, "true")).toBeGreaterThan(0);
    });
});

describe("backoffDelayMs", () => {
    it("grows with attempt", () => {
        // jittered, so compare the floors (0.5x base)
        expect(backoffDelayMs(2)).toBeGreaterThan(backoffDelayMs(1) * 0.5);
    });
});

describe("isRetryableErrorBody", () => {
    it("detects LiteLLM-mislabeled Bedrock 503", () => {
        expect(isRetryableErrorBody("... serviceUnavailableException ...")).toBe(true);
    });
    it("false for ordinary 400s", () => {
        expect(isRetryableErrorBody("invalid model id")).toBe(false);
    });
});

describe("messagesReferenceTools", () => {
    it("true when a tool-role message exists", () => {
        expect(messagesReferenceTools([{ role: "tool", content: "x" }])).toBe(true);
    });
    it("true when an assistant turn has tool_calls", () => {
        expect(
            messagesReferenceTools([{ role: "assistant", tool_calls: [{ id: "1" }] }]),
        ).toBe(true);
    });
    it("false for plain chat", () => {
        expect(messagesReferenceTools([{ role: "user", content: "hi" }])).toBe(false);
    });
});

describe("scrubBedrockToolFields", () => {
    it("drops tool_choice:none and its tools", () => {
        const body = scrubBedrockToolFields({
            tools: [{ type: "function" }],
            tool_choice: { type: "none" },
        }) as Record<string, unknown>;
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });
    it("coerces tool_choice:required to auto", () => {
        const body = scrubBedrockToolFields({
            tools: [{ type: "function" }],
            tool_choice: { type: "required" },
        }) as Record<string, unknown>;
        expect(body.tool_choice).toBe("auto");
    });
    it("injects a dummy tool when history references tools but none declared", () => {
        const body = scrubBedrockToolFields({
            messages: [{ role: "tool", content: "x" }],
        }) as Record<string, unknown>;
        expect(Array.isArray(body.tools)).toBe(true);
    });
    it("strips legacy functions/function_call", () => {
        const body = scrubBedrockToolFields({
            functions: [{}],
            function_call: "auto",
        }) as Record<string, unknown>;
        expect("functions" in body).toBe(false);
        expect("function_call" in body).toBe(false);
    });
});

describe("sanitizeBedrockContent", () => {
    it("replaces blank string content with a placeholder", () => {
        const body = { messages: [{ role: "user", content: "   " }] };
        sanitizeBedrockContent(body);
        expect(body.messages[0].content).toBe(".");
    });
    it("backfills empty content arrays", () => {
        const body = { messages: [{ role: "user", content: [] as unknown[] }] };
        sanitizeBedrockContent(body);
        expect((body.messages[0].content as unknown[]).length).toBe(1);
    });
});

describe("shapeBedrockRequestBody", () => {
    it("scrubs then sanitizes in one pass", () => {
        const out = shapeBedrockRequestBody({
            functions: [{}],
            messages: [{ role: "user", content: "" }],
        });
        expect("functions" in out).toBe(false);
        expect((out.messages as Array<{ content: unknown }>)[0].content).toBe(".");
    });
});

describe("parseUsageFromBuffer", () => {
    it("extracts the last usage block", () => {
        const buf =
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"cached_tokens":2}}';
        expect(parseUsageFromBuffer(buf)).toEqual({
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 0,
        });
    });
    it("returns undefined without a usage block", () => {
        expect(parseUsageFromBuffer("data: {}")).toBeUndefined();
    });
});

describe("inferModelLimits (OWUI/LiteLLM+Bedrock, verified live + catalog)", () => {
    const cases: [string, number, number][] = [
        // id, contextWindow, output — the values that stop premature compaction.
        ["bedrock-claude-5-opus", 1_000_000, 128_000],
        ["bedrock-claude-5-sonnet", 1_000_000, 128_000],
        ["bedrock-claude-4-6-opus", 1_000_000, 128_000],
        ["bedrock-claude-4-6-sonnet", 1_000_000, 128_000],
        ["bedrock-claude-4-5-haiku", 200_000, 64_000],
        ["bedrock-nova-pro-v1", 300_000, 10_000],
        ["openai.gpt-5.6-sol", 1_050_000, 128_000],
        ["openai.gpt-5.6-luna", 1_050_000, 128_000],
        ["openai.gpt-oss-120b-1:0", 128_000, 128_000],
        ["google.gemma-3-12b-it", 128_000, 131_072],
        ["meta.llama4-maverick-17b-instruct-v1:0", 1_000_000, 8_192],
    ];
    for (const [id, context, output] of cases) {
        it(`${id} -> ${context.toLocaleString()} / ${output.toLocaleString()}`, () => {
            const limits = inferModelLimits(id, "");
            expect(limits.context).toBe(context);
            expect(limits.output).toBe(output);
        });
    }

    it("does not collapse Claude 5/4.6 to the 200K /claude/ fallback", () => {
        // Regression: bare /claude/ = 200K made a 1M Opus 5 compact at ~180K.
        expect(inferModelLimits("bedrock-claude-5-opus", "").context).toBeGreaterThan(
            200_000,
        );
    });
});
