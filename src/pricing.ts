export interface ModelPricing {
    inputPerMTok: number;
    outputPerMTok: number;
    cacheReadPerMTok: number;
    cacheWritePerMTok: number;
}

const GPT_5: ModelPricing = { inputPerMTok: 2.50, outputPerMTok: 10, cacheReadPerMTok: 0.25, cacheWritePerMTok: 0 };
const GPT_4O: ModelPricing = { inputPerMTok: 2.50, outputPerMTok: 10, cacheReadPerMTok: 1.25, cacheWritePerMTok: 0 };
const GPT_4_TURBO: ModelPricing = { inputPerMTok: 10, outputPerMTok: 30, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };
const GPT_OSS_120B: ModelPricing = { inputPerMTok: 0.15, outputPerMTok: 0.60, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

const BEDROCK_OPUS_4X: ModelPricing = { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 };
const BEDROCK_SONNET_4X: ModelPricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 };
const BEDROCK_HAIKU_4X: ModelPricing = { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 };

const UNKNOWN_DEFAULT: ModelPricing = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 };

export function getModelPricing(modelId: string | undefined): ModelPricing {
    if (!modelId) return UNKNOWN_DEFAULT;

    if (/opus[-_]?4|4[-_]?\d+[-_]?opus/i.test(modelId)) return BEDROCK_OPUS_4X;
    if (/sonnet[-_]?4|4[-_]?\d+[-_]?sonnet/i.test(modelId)) return BEDROCK_SONNET_4X;
    if (/haiku[-_]?4|4[-_]?\d+[-_]?haiku/i.test(modelId)) return BEDROCK_HAIKU_4X;

    const m = modelId.toLowerCase();
    if (m.includes("gpt-5")) return GPT_5;
    if (m.includes("gpt-4o")) return GPT_4O;
    if (m.includes("gpt-4-turbo")) return GPT_4_TURBO;
    if (m.includes("gpt-oss")) return GPT_OSS_120B;

    return UNKNOWN_DEFAULT;
}

export function computeUsageCost(
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
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
