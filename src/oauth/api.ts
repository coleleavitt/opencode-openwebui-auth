import type { OpenWebUIConfigResponse, OpenWebUIModelsResponse } from "../types";

function stripTrailingSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function normalizeBaseUrl(url: string): string {
    const trimmed = stripTrailingSlash(url.trim());
    if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error(`Base URL must start with http:// or https:// (got ${trimmed})`);
    }
    return trimmed;
}

export async function fetchInstanceConfig(baseUrl: string): Promise<OpenWebUIConfigResponse> {
    const res = await fetch(`${baseUrl}/api/config`, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
    return (await res.json()) as OpenWebUIConfigResponse;
}

export async function verifyToken(baseUrl: string, token: string): Promise<{ id: string; email: string; role: string; name: string }> {
    const res = await fetch(`${baseUrl}/api/v1/auths/`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Token rejected (${res.status}): ${body.slice(0, 200)}`);
    }
    return (await res.json()) as { id: string; email: string; role: string; name: string };
}

export async function listModels(baseUrl: string, token: string): Promise<OpenWebUIModelsResponse> {
    const res = await fetch(`${baseUrl}/api/models`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
    return (await res.json()) as OpenWebUIModelsResponse;
}

type ModelLimits = { context: number; output: number };

// Sourced from LiteLLM v1.81.12 model_prices_and_context_window.json
// (cloned at ~/VulnerabilityResearch/chat_ai2s_org/litellm/ tag v1.81.12-stable.2).
// OWUI's /api/models returns context_length: null for all models, so we infer
// from the model ID/name. Ordered most-specific-first; first match wins.
const MODEL_LIMITS: [RegExp, ModelLimits][] = [
    [/claude.*opus.*4[._-]?6/i,      { context: 1000000, output: 128000 }],
    [/claude.*opus.*4[._-]?5/i,      { context: 200000,  output: 64000 }],
    [/claude.*opus.*4[._-]?[01]/i,   { context: 200000,  output: 32000 }],
    [/claude.*haiku.*4[._-]?5/i,     { context: 200000,  output: 64000 }],
    [/claude.*sonnet.*4[._-]?[56]/i, { context: 200000,  output: 64000 }],
    [/claude.*sonnet.*4/i,           { context: 200000,  output: 16000 }],
    [/claude/i,                      { context: 200000,  output: 16000 }],
    [/gpt.*5/i,                      { context: 1000000, output: 100000 }],
    [/gpt.*4o/i,                     { context: 128000,  output: 16384 }],
    [/gpt.*4/i,                      { context: 128000,  output: 8192 }],
    [/llama.*4.*maverick/i,          { context: 1048576, output: 65536 }],
    [/llama.*4/i,                    { context: 131072,  output: 16384 }],
    [/llama.*3/i,                    { context: 131072,  output: 8192 }],
    [/gemma.*3/i,                    { context: 128000,  output: 8192 }],
    [/gemini.*2/i,                   { context: 1048576, output: 65536 }],
    [/nova.*pro/i,                   { context: 300000,  output: 5000 }],
    [/nova.*lite/i,                  { context: 300000,  output: 5000 }],
];
const DEFAULT_LIMITS: ModelLimits = { context: 128000, output: 16384 };

function inferModelLimits(modelId: string, modelName: string): ModelLimits {
    const haystack = `${modelId} ${modelName}`;
    for (const [pattern, limits] of MODEL_LIMITS) {
        if (pattern.test(haystack)) return limits;
    }
    return DEFAULT_LIMITS;
}

export function buildOpencodeModel(
    providerID: string,
    baseUrl: string,
    npm: string,
    raw: import("../types").OpenWebUIModelInfo,
): Record<string, unknown> {
    const caps = raw.info?.meta?.capabilities ?? {};
    const limits = inferModelLimits(raw.id, raw.name ?? "");
    return {
        id: raw.id,
        providerID,
        name: raw.name ?? raw.id,
        family: "",
        api: { id: raw.id, url: `${baseUrl}/api`, npm },
        status: "active" as const,
        headers: {},
        options: {},
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: limits.context, output: limits.output },
        capabilities: {
            temperature: true,
            reasoning: false,
            attachment: Boolean(caps.file_upload || caps.vision),
            toolcall: Boolean(caps.builtin_tools ?? true),
            input: {
                text: true,
                audio: false,
                image: Boolean(caps.vision),
                video: false,
                pdf: Boolean(caps.file_upload),
            },
            output: {
                text: true,
                audio: false,
                image: Boolean(caps.image_generation),
                video: false,
                pdf: false,
            },
            interleaved: false,
        },
        release_date: "",
        variants: {},
    };
}
