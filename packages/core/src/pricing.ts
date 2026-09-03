/**
 * Per-model token pricing for usage accounting.
 *
 * Rates are the published list prices of the underlying model, matched most
 * specific first. A model with no entry is reported as UNKNOWN rather than as
 * free: a silent $0 is indistinguishable from "this model costs nothing", which
 * previously hid every Claude 5 request from the cost totals.
 */

export interface ModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
}

export interface ResolvedModelPricing {
    pricing: ModelPricing;
    /** False when no rule matched, so the caller can flag the total as partial. */
    known: boolean;
    /** The rule that matched, for diagnostics. */
    label: string;
}

// OpenAI list prices.
const GPT_5: ModelPricing = {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 0,
};
const GPT_4O: ModelPricing = {
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
    cacheWritePerMTok: 0,
};
const GPT_4_TURBO: ModelPricing = {
    inputPerMTok: 10,
    outputPerMTok: 30,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
};
const GPT_OSS_120B: ModelPricing = {
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
};

// Bedrock list prices. Claude 5 bills at the same rates as the matching 4.x tier.
const BEDROCK_OPUS: ModelPricing = {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
};
const BEDROCK_SONNET: ModelPricing = {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
};
const BEDROCK_HAIKU: ModelPricing = {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
};
const NOVA_PRO: ModelPricing = {
    inputPerMTok: 0.8,
    outputPerMTok: 3.2,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 0,
};
const LLAMA4_MAVERICK: ModelPricing = {
    inputPerMTok: 0.24,
    outputPerMTok: 0.97,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
};
// Gemma 4 31B is Apache-2.0 open weights, so there is no single vendor price.
// These are the baseline managed-API rates; a self-hosted deployment bills
// nothing per token, and other gateways charge several times the input rate.
const GEMMA_4_31B: ModelPricing = {
    inputPerMTok: 0.09,
    outputPerMTok: 0.34,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0,
};

export const UNKNOWN_PRICING: ModelPricing = {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheReadPerMTok: 0,
    cacheWritePerMTok: 0,
};

/**
 * Ordered match table. Claude ids order family and version either way
 * (`claude-opus-4-6` and `bedrock-claude-5-opus` both occur), so each rule
 * accepts both orders instead of anchoring on one.
 */
const PRICING_RULES: {
    label: string;
    pattern: RegExp;
    pricing: ModelPricing;
}[] = [
    {
        label: "bedrock-opus",
        pattern: /claude.*opus|opus.*claude|(?:^|[^a-z])opus[-_]?\d/i,
        pricing: BEDROCK_OPUS,
    },
    {
        label: "bedrock-sonnet",
        pattern: /claude.*sonnet|sonnet.*claude|(?:^|[^a-z])sonnet[-_]?\d/i,
        pricing: BEDROCK_SONNET,
    },
    {
        label: "bedrock-haiku",
        pattern: /claude.*haiku|haiku.*claude|(?:^|[^a-z])haiku[-_]?\d/i,
        pricing: BEDROCK_HAIKU,
    },
    { label: "nova-pro", pattern: /nova[-_]?pro/i, pricing: NOVA_PRO },
    {
        label: "gemma-4-31b",
        pattern: /gemma[-_.]?4[-_.]?31b/i,
        pricing: GEMMA_4_31B,
    },
    {
        label: "llama4-maverick",
        pattern: /llama[-_]?4.*maverick/i,
        pricing: LLAMA4_MAVERICK,
    },
    { label: "gpt-oss", pattern: /gpt[-_]?oss/i, pricing: GPT_OSS_120B },
    { label: "gpt-5", pattern: /gpt[-_]?5/i, pricing: GPT_5 },
    { label: "gpt-4o", pattern: /gpt[-_]?4o/i, pricing: GPT_4O },
    {
        label: "gpt-4-turbo",
        pattern: /gpt[-_]?4[-_]?turbo/i,
        pricing: GPT_4_TURBO,
    },
];

/** Resolve pricing and report whether a rule actually matched. */
export function resolveModelPricing(
    modelId: string | undefined,
): ResolvedModelPricing {
    if (!modelId)
        return { pricing: UNKNOWN_PRICING, known: false, label: "unknown" };
    for (const rule of PRICING_RULES) {
        if (rule.pattern.test(modelId)) {
            return { pricing: rule.pricing, known: true, label: rule.label };
        }
    }
    return { pricing: UNKNOWN_PRICING, known: false, label: "unknown" };
}

export function getModelPricing(modelId: string | undefined): ModelPricing {
    return resolveModelPricing(modelId).pricing;
}

export function computeUsageCost(
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    },
    pricing: ModelPricing,
): number {
    const raw =
        (usage.input / 1e6) * pricing.inputPerMTok +
        (usage.output / 1e6) * pricing.outputPerMTok +
        (usage.cacheRead / 1e6) * pricing.cacheReadPerMTok +
        (usage.cacheWrite / 1e6) * pricing.cacheWritePerMTok;
    return Math.round(raw * 1e6) / 1e6;
}

export function normalizeModelKey(modelId: string | undefined): string {
    if (!modelId) return "unknown";
    return modelId.toLowerCase().replace(/-\d{8}$/, "");
}
