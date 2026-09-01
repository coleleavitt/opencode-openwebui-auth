import { describe, expect, it } from "bun:test";
import {
    backoffDelayMs,
    buildClaudeVariants,
    inferModelLimits,
    isRetryableErrorBody,
    MAX_RETRY_AFTER_MS,
    messagesReferenceTools,
    nextRetryDelayMs,
    parseRetryAfterMs,
    parseUsageFromBuffer,
    repairDanglingToolCalls,
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
        expect(parseRetryAfterMs(resWith(429, { "retry-after": "2" }))).toBe(
            2000,
        );
    });
    it("returns undefined when absent", () => {
        expect(parseRetryAfterMs(resWith(429))).toBeUndefined();
    });
    it("clamps negatives to 0", () => {
        expect(parseRetryAfterMs(resWith(429, { "retry-after": "-3" }))).toBe(
            0,
        );
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
        expect(
            isRetryableErrorBody("... serviceUnavailableException ..."),
        ).toBe(true);
    });
    it("false for ordinary 400s", () => {
        expect(isRetryableErrorBody("invalid model id")).toBe(false);
    });
});

describe("messagesReferenceTools", () => {
    it("true when a tool-role message exists", () => {
        expect(messagesReferenceTools([{ role: "tool", content: "x" }])).toBe(
            true,
        );
    });
    it("true when an assistant turn has tool_calls", () => {
        expect(
            messagesReferenceTools([
                { role: "assistant", tool_calls: [{ id: "1" }] },
            ]),
        ).toBe(true);
    });
    it("false for plain chat", () => {
        expect(messagesReferenceTools([{ role: "user", content: "hi" }])).toBe(
            false,
        );
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

describe("repairDanglingToolCalls", () => {
    const callMsg = (...ids: string[]) => ({
        role: "assistant",
        content: null,
        tool_calls: ids.map((id) => ({
            id,
            type: "function",
            function: { name: "ipython", arguments: "{}" },
        })),
    });
    const msgsOf = (body: unknown) =>
        (body as { messages: Array<Record<string, unknown>> }).messages;

    it("answers a tool call the host never returned", () => {
        const body = repairDanglingToolCalls({
            messages: [
                { role: "user", content: "run it" },
                callMsg("call_a"),
                { role: "user", content: "continue" },
            ],
        });
        const msgs = msgsOf(body);
        expect(msgs.length).toBe(4);
        expect(msgs[2].role).toBe("tool");
        expect(msgs[2].tool_call_id).toBe("call_a");
        expect(msgs[3].content).toBe("continue");
    });

    it("leaves an already-answered call untouched", () => {
        const original = [
            callMsg("call_a"),
            { role: "tool", tool_call_id: "call_a", content: "42" },
        ];
        const msgs = msgsOf(
            repairDanglingToolCalls({ messages: [...original] }),
        );
        expect(msgs.length).toBe(2);
        expect(msgs[1].content).toBe("42");
    });

    it("backfills only the unanswered call in a parallel batch", () => {
        const msgs = msgsOf(
            repairDanglingToolCalls({
                messages: [
                    callMsg("call_a", "call_b"),
                    { role: "tool", tool_call_id: "call_a", content: "42" },
                ],
            }),
        );
        expect(msgs.length).toBe(3);
        expect(msgs[2].tool_call_id).toBe("call_b");
        expect(msgs[1].content).toBe("42");
    });

    it("keeps replies adjacent to their own assistant turn", () => {
        const msgs = msgsOf(
            repairDanglingToolCalls({
                messages: [
                    callMsg("call_a"),
                    { role: "user", content: "still there?" },
                    callMsg("call_b"),
                ],
            }),
        );
        expect(msgs.map((m) => m.role)).toEqual([
            "assistant",
            "tool",
            "user",
            "assistant",
            "tool",
        ]);
        expect(msgs[1].tool_call_id).toBe("call_a");
        expect(msgs[4].tool_call_id).toBe("call_b");
    });

    it("is a no-op for histories with no tool calls", () => {
        const msgs = msgsOf(
            repairDanglingToolCalls({
                messages: [{ role: "user", content: "hi" }],
            }),
        );
        expect(msgs.length).toBe(1);
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
        expect((out.messages as Array<{ content: unknown }>)[0].content).toBe(
            ".",
        );
    });
    it("repairs a dangling tool call and still declares a tool for it", () => {
        const out = shapeBedrockRequestBody({
            messages: [
                { role: "user", content: "run it" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_a",
                            type: "function",
                            function: { name: "ipython", arguments: "{}" },
                        },
                    ],
                },
            ],
        });
        const msgs = out.messages as Array<Record<string, unknown>>;
        expect(msgs[2].role).toBe("tool");
        expect(msgs[2].tool_call_id).toBe("call_a");
        // The synthesized reply must be visible to the dummy-tool scan, or
        // Bedrock rejects the tool history for having no `tools` declared.
        expect(Array.isArray(out.tools)).toBe(true);
    });

    it("drops temperature/top_p for gpt-5.6, which rejects both", () => {
        const out = shapeBedrockRequestBody({
            model: "openai.gpt-5.6-sol",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.5,
            top_p: 0.9,
        });
        expect("temperature" in out).toBe(false);
        expect("top_p" in out).toBe(false);
    });

    it("pins temperature to 1 for claude 5, which accepts nothing else", () => {
        const pinned = shapeBedrockRequestBody({
            model: "bedrock-claude-5-opus",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.7,
        });
        expect(pinned.temperature).toBe(1);
        const untouched = shapeBedrockRequestBody({
            model: "bedrock-claude-4-6-sonnet",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.7,
        });
        expect(untouched.temperature).toBe(0.7);
    });

    it("keeps temperature but drops top_p when a model gets both", () => {
        const out = shapeBedrockRequestBody({
            model: "bedrock-claude-4-6-sonnet",
            messages: [{ role: "user", content: "hi" }],
            temperature: 0.5,
            top_p: 0.9,
        });
        expect(out.temperature).toBe(0.5);
        expect("top_p" in out).toBe(false);
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
        ["google.gemma-3-12b-it", 128_000, 8_192],
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
        expect(
            inferModelLimits("bedrock-claude-5-opus", "").context,
        ).toBeGreaterThan(200_000);
    });
});

describe("buildClaudeVariants (shapes verified live against OWUI/LiteLLM+Bedrock)", () => {
    type ClaudeVariant = {
        thinking: {
            type: string;
            display?: string;
            effort?: string;
            budgetTokens?: number;
        };
        output_config?: { effort: string };
        effort?: string;
    };
    const asVariant = (v: unknown) => v as ClaudeVariant;

    // Every model this deployment serves, and the efforts it accepted live.
    const adaptive: [string, string[]][] = [
        ["bedrock-claude-5-opus", ["low", "medium", "high", "xhigh", "max"]],
        ["bedrock-claude-5-sonnet", ["low", "medium", "high", "xhigh", "max"]],
        ["bedrock-claude-4-6-opus", ["low", "medium", "high", "xhigh", "max"]],
        ["bedrock-claude-4-6-sonnet", ["low", "medium", "high", "max"]],
    ];

    for (const [id, efforts] of adaptive) {
        it(`${id} -> adaptive thinking, efforts ${efforts.join("/")}`, () => {
            const variants = buildClaudeVariants(id);
            expect(Object.keys(variants).sort()).toEqual([...efforts].sort());
            for (const effort of efforts) {
                const v = asVariant(variants[effort]);
                expect(v.thinking.type).toBe("adaptive");
                expect(v.output_config).toEqual({ effort });
                // Rejected live as "Extra inputs are not permitted".
                expect(v.effort).toBeUndefined();
                expect(v.thinking.effort).toBeUndefined();
            }
        });
    }

    it("never emits legacy thinking for Claude 5 (provider 400s on it)", () => {
        for (const id of ["bedrock-claude-5-opus", "bedrock-claude-5-sonnet"]) {
            for (const v of Object.values(buildClaudeVariants(id))) {
                expect(asVariant(v).thinking.type).not.toBe("enabled");
            }
        }
    });

    it("haiku-4-5 gets adaptive thinking but no effort param", () => {
        const variants = buildClaudeVariants("bedrock-claude-4-5-haiku");
        expect(Object.keys(variants).length).toBeGreaterThan(0);
        for (const v of Object.values(variants)) {
            expect(asVariant(v).thinking.type).toBe("adaptive");
            // "This model does not support the effort parameter."
            expect(asVariant(v).output_config).toBeUndefined();
        }
    });

    it("matches family/version in either id order", () => {
        expect(
            Object.keys(buildClaudeVariants("claude-opus-4-6")).sort(),
        ).toEqual(
            Object.keys(buildClaudeVariants("bedrock-claude-4-6-opus")).sort(),
        );
    });

    it("does not read a date stamp as a version", () => {
        // claude-sonnet-4-20250514 must be generation 4, not 4.2.
        for (const v of Object.values(
            buildClaudeVariants("claude-sonnet-4-20250514"),
        )) {
            expect(asVariant(v).thinking.type).toBe("enabled");
        }
    });

    it("keeps legacy budgets for pre-4.5 Claude", () => {
        const variants = buildClaudeVariants("claude-3-5-sonnet");
        expect(asVariant(variants.high).thinking).toEqual({
            type: "enabled",
            budgetTokens: 16000,
        });
    });

    it("sonnet-4.6 does not advertise xhigh (rejected live)", () => {
        expect(
            buildClaudeVariants("bedrock-claude-4-6-sonnet").xhigh,
        ).toBeUndefined();
        expect(
            buildClaudeVariants("bedrock-claude-4-6-opus").xhigh,
        ).toBeDefined();
    });
});
