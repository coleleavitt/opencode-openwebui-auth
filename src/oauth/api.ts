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

// Model limits sourced from Anthropic v2.1.137 CLI (sAH() function) + LiteLLM
// v1.81.12 model_prices_and_context_window.json. Ordered most-specific-first.
const MODEL_LIMITS: [RegExp, ModelLimits][] = [
    [/claude.*mythos/i,              { context: 1000000, output: 128000 }],
    [/claude.*opus.*4[._-]?7/i,      { context: 1000000, output: 128000 }],
    [/claude.*opus.*4[._-]?6/i,      { context: 1000000, output: 128000 }],
    [/claude.*opus.*4[._-]?5/i,      { context: 200000,  output: 64000 }],
    [/claude.*opus.*4[._-]?[01]/i,   { context: 200000,  output: 32000 }],
    [/claude.*haiku.*4[._-]?5/i,     { context: 200000,  output: 64000 }],
    // sonnet-4-6 default output is 32K per v138 sAH() — not 64K.
    // 128K output requires the output-128k-2025-02-19 beta header.
    [/claude.*sonnet.*4[._-]?6/i,    { context: 200000,  output: 32000 }],
    [/claude.*sonnet.*4[._-]?5/i,    { context: 200000,  output: 64000 }],
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

// Claude models that support adaptive thinking via the Anthropic API.
// Adaptive thinking (type: "adaptive") is the correct form for Claude 4.x —
// the legacy { type: "enabled", budgetTokens } form still works but is
// deprecated. Claude 4.6+ also supports xhigh effort via adaptive.
// The OWUI proxy forwards these params verbatim to the underlying provider
// (Bedrock, direct Anthropic, etc.) so we can set the full variant map here.
const CLAUDE_EFFORTS_BASE = ["low", "medium", "high", "max"] as const
const CLAUDE_EFFORTS_XHIGH = ["low", "medium", "high", "xhigh", "max"] as const
// xhigh effort is opus-4-7 / mythos only per Anthropic v2.1.137 CLI (E5$ fn).
const CLAUDE_MODELS_WITH_XHIGH = /claude.*(opus.*4[._-]?7|mythos)/i
const CLAUDE_MODELS_WITH_ADAPTIVE_THINKING = /claude.*(sonnet|opus|haiku|mythos).*(4[._-]?[56789]|[5-9][._-]?[0-9]|preview)/i

function buildClaudeVariants(modelId: string): Record<string, unknown> {
    if (!CLAUDE_MODELS_WITH_ADAPTIVE_THINKING.test(modelId)) {
        return {
            high: { thinking: { type: "enabled", budgetTokens: 16000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31999 } },
        }
    }
    const isOpus47 = CLAUDE_MODELS_WITH_XHIGH.test(modelId)
    const efforts = isOpus47 ? CLAUDE_EFFORTS_XHIGH : CLAUDE_EFFORTS_BASE
    return Object.fromEntries(
        efforts.map((effort) => [
            effort,
            {
                thinking: {
                    type: "adaptive",
                    // opus-4-7 specific: summarized display reduces token
                    // overhead of reasoning traces in multi-turn contexts.
                    ...(isOpus47 ? { display: "summarized" } : {}),
                },
                effort,
            },
        ]),
    )
}

export function buildOpencodeModel(
    providerID: string,
    baseUrl: string,
    npm: string,
    raw: import("../types").OpenWebUIModelInfo,
): Record<string, unknown> {
    const caps = raw.info?.meta?.capabilities ?? {};
    const limits = inferModelLimits(raw.id, raw.name ?? "");
    const isClaude = /claude/i.test(raw.id)
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
            // Claude models support adaptive thinking. Non-Claude models
            // go through the generic openai-compatible path (reasoningEffort)
            // which transform.ts handles separately when reasoning: true.
            reasoning: isClaude,
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
        variants: isClaude ? buildClaudeVariants(raw.id) : {},
    };
}
