import { describe, expect, test } from "bun:test";
import {
    computeUsageCost,
    getModelPricing,
    normalizeModelKey,
    resolveModelPricing,
} from "./pricing";

describe("getModelPricing", () => {
    test("returns zero pricing for undefined model", () => {
        const p = getModelPricing(undefined);
        expect(p.inputPerMTok).toBe(0);
        expect(p.outputPerMTok).toBe(0);
    });

    test("returns zero pricing for unknown model", () => {
        const p = getModelPricing("llama-3.1-70b");
        expect(p.inputPerMTok).toBe(0);
    });

    test("matches GPT-5", () => {
        const p = getModelPricing("gpt-5-latest");
        expect(p.inputPerMTok).toBe(2.5);
        expect(p.outputPerMTok).toBe(10);
    });

    test("matches GPT-4o", () => {
        const p = getModelPricing("openai.gpt-4o-2024-08-06");
        expect(p.inputPerMTok).toBe(2.5);
        expect(p.outputPerMTok).toBe(10);
        expect(p.cacheReadPerMTok).toBe(1.25);
    });

    test("matches GPT-4-turbo", () => {
        const p = getModelPricing("gpt-4-turbo-preview");
        expect(p.inputPerMTok).toBe(10);
        expect(p.outputPerMTok).toBe(30);
    });

    test("matches GPT-OSS-120B", () => {
        const p = getModelPricing("openai.gpt-oss-120b-1:0");
        expect(p.inputPerMTok).toBe(0.15);
        expect(p.outputPerMTok).toBe(0.6);
    });

    test("matches Bedrock Claude Opus 4", () => {
        const p = getModelPricing("bedrock-claude-4-6-opus");
        expect(p.inputPerMTok).toBe(15);
        expect(p.outputPerMTok).toBe(75);
        expect(p.cacheReadPerMTok).toBe(1.5);
        expect(p.cacheWritePerMTok).toBe(18.75);
    });

    test("matches Bedrock Claude Sonnet 4", () => {
        const p = getModelPricing("bedrock-claude-sonnet-4-20250514");
        expect(p.inputPerMTok).toBe(3);
        expect(p.outputPerMTok).toBe(15);
    });

    test("matches Bedrock Claude Haiku 4", () => {
        const p = getModelPricing("bedrock-claude-haiku-4-20250514");
        expect(p.inputPerMTok).toBe(1);
        expect(p.outputPerMTok).toBe(5);
    });
});

describe("computeUsageCost", () => {
    test("computes cost for Opus usage", () => {
        const pricing = getModelPricing("bedrock-claude-4-6-opus");
        const cost = computeUsageCost(
            { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 },
            pricing,
        );
        const expected =
            (1000 / 1e6) * 15 +
            (500 / 1e6) * 75 +
            (200 / 1e6) * 1.5 +
            (100 / 1e6) * 18.75;
        expect(cost).toBeCloseTo(expected, 6);
    });

    test("returns 0 for unknown model", () => {
        const pricing = getModelPricing("llama-3.1-70b");
        const cost = computeUsageCost(
            { input: 10000, output: 5000, cacheRead: 0, cacheWrite: 0 },
            pricing,
        );
        expect(cost).toBe(0);
    });

    test("handles zero tokens", () => {
        const pricing = getModelPricing("gpt-5");
        const cost = computeUsageCost(
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            pricing,
        );
        expect(cost).toBe(0);
    });
});

describe("normalizeModelKey", () => {
    test("lowercases model id", () => {
        expect(normalizeModelKey("GPT-4o")).toBe("gpt-4o");
    });

    test("strips date suffix", () => {
        expect(normalizeModelKey("bedrock-claude-sonnet-4-20250514")).toBe(
            "bedrock-claude-sonnet-4",
        );
    });

    test("returns 'unknown' for undefined", () => {
        expect(normalizeModelKey(undefined)).toBe("unknown");
    });

    test("preserves vendor prefixes", () => {
        expect(normalizeModelKey("bedrock-claude-4-6-opus")).toBe(
            "bedrock-claude-4-6-opus",
        );
    });
});

describe("resolveModelPricing — models this deployment actually serves", () => {
    // Claude 5 previously matched no rule and was billed at $0, which hid every
    // Opus 5 and Sonnet 5 request from the totals.
    test.each([
        ["bedrock-claude-5-opus", "bedrock-opus", 15, 75],
        ["bedrock-claude-5-sonnet", "bedrock-sonnet", 3, 15],
        ["bedrock-claude-4-6-opus", "bedrock-opus", 15, 75],
        ["bedrock-claude-4-6-sonnet", "bedrock-sonnet", 3, 15],
        ["bedrock-claude-4-5-haiku", "bedrock-haiku", 1, 5],
        ["bedrock-nova-pro-v1", "nova-pro", 0.8, 3.2],
        [
            "meta.llama4-maverick-17b-instruct-v1:0",
            "llama4-maverick",
            0.24,
            0.97,
        ],
        ["openai.gpt-oss-120b-1:0", "gpt-oss", 0.15, 0.6],
        ["openai.gpt-5.6-sol", "gpt-5", 2.5, 10],
        ["openai.gpt-5.6-luna", "gpt-5", 2.5, 10],
        ["openai.gpt-5.6-terra", "gpt-5", 2.5, 10],
    ])("%s is priced by rule %s", (id, label, input, output) => {
        const resolved = resolveModelPricing(id);
        expect(resolved.known).toBe(true);
        expect(resolved.label).toBe(label);
        expect(resolved.pricing.inputPerMTok).toBe(input);
        expect(resolved.pricing.outputPerMTok).toBe(output);
    });

    test("Claude 5 Opus bills a megatoken at the Opus rate, not zero", () => {
        const resolved = resolveModelPricing("bedrock-claude-5-opus");
        const cost = computeUsageCost(
            { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            resolved.pricing,
        );
        expect(cost).toBe(15);
    });

    test("matches a Claude family in either id order", () => {
        expect(resolveModelPricing("claude-opus-4-6").label).toBe(
            "bedrock-opus",
        );
        expect(resolveModelPricing("bedrock-claude-5-opus").label).toBe(
            "bedrock-opus",
        );
    });

    test("an unmatched model is reported as unknown, not as free", () => {
        const resolved = resolveModelPricing("google.gemma-4-31b");
        expect(resolved.known).toBe(false);
        expect(resolved.label).toBe("unknown");
        expect(resolved.pricing.inputPerMTok).toBe(0);
    });

    test("undefined and unrelated ids stay unknown", () => {
        expect(resolveModelPricing(undefined).known).toBe(false);
        expect(resolveModelPricing("llama-3.1-70b").known).toBe(false);
    });

    test("getModelPricing still returns the bare pricing for existing callers", () => {
        expect(getModelPricing("bedrock-claude-5-opus")).toEqual(
            resolveModelPricing("bedrock-claude-5-opus").pricing,
        );
        expect(normalizeModelKey("Bedrock-Claude-5-Opus")).toBe(
            "bedrock-claude-5-opus",
        );
    });
});
