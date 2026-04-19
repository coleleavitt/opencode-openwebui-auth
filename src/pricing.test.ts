import { describe, expect, test } from "bun:test";
import { computeUsageCost, getModelPricing, normalizeModelKey } from "./pricing";

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
        expect(p.outputPerMTok).toBe(0.60);
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
        expect(normalizeModelKey("bedrock-claude-sonnet-4-20250514")).toBe("bedrock-claude-sonnet-4");
    });

    test("returns 'unknown' for undefined", () => {
        expect(normalizeModelKey(undefined)).toBe("unknown");
    });

    test("preserves vendor prefixes", () => {
        expect(normalizeModelKey("bedrock-claude-4-6-opus")).toBe("bedrock-claude-4-6-opus");
    });
});
