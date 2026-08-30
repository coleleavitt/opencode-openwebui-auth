import type {
    OpenWebUIConfigResponse,
    OpenWebUIModelsResponse,
} from "../types";

function stripTrailingSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function normalizeBaseUrl(url: string): string {
    const trimmed = stripTrailingSlash(url.trim());
    if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error(
            `Base URL must start with http:// or https:// (got ${trimmed})`,
        );
    }
    return trimmed;
}

export async function fetchInstanceConfig(
    baseUrl: string,
): Promise<OpenWebUIConfigResponse> {
    const res = await fetch(`${baseUrl}/api/config`, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
    return (await res.json()) as OpenWebUIConfigResponse;
}

export async function verifyToken(
    baseUrl: string,
    token: string,
): Promise<{ id: string; email: string; role: string; name: string }> {
    const res = await fetch(`${baseUrl}/api/v1/auths/`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
            `Token rejected (${res.status}): ${body.slice(0, 200)}`,
        );
    }
    return (await res.json()) as {
        id: string;
        email: string;
        role: string;
        name: string;
    };
}

export async function listModels(
    baseUrl: string,
    token: string,
): Promise<OpenWebUIModelsResponse> {
    const res = await fetch(`${baseUrl}/api/models`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
    return (await res.json()) as OpenWebUIModelsResponse;
}

export type ModelLimits = { context: number; output: number };

// Model limits sourced from Anthropic v2.1.137 CLI (sAH() function) + LiteLLM
// v1.81.12 model_prices_and_context_window.json. Ordered most-specific-first.
// Limits reconciled from the LiteLLM catalog (model_prices_and_context_window.json)
// AND live probing of this OWUI/LiteLLM+Bedrock deployment. Where the catalog's
// stale bedrock entry disagreed with the deployment (e.g. llama4-maverick), the
// live-verified value wins. Ordered most-specific-first; first match wins.
//
// IMPORTANT: Claude 5 / 4.6 (opus + sonnet) are 1M context / 128K output here —
// NOT 200K. Matching them to a bare /claude/ = 200K made the agent compact far
// too early (a 1M-window Opus 5 session was compacting at ~180K).
const MODEL_LIMITS: [RegExp, ModelLimits][] = [
    [/claude.*mythos/i, { context: 1000000, output: 128000 }],
    // Claude 5 (opus + sonnet): 1M ctx / 128K out (verified live 900K ok, 1.05M fail).
    [/claude.*(opus|sonnet).*5/i, { context: 1000000, output: 128000 }],
    [/claude.*5.*(opus|sonnet)/i, { context: 1000000, output: 128000 }],
    // Claude 4.7 / 4.6 opus + sonnet: 1M ctx / 128K out (catalog + live). The id
    // may order the name either way (claude-opus-4-6 or claude-4-6-opus), so match
    // "4-6/4-7" plus "opus|sonnet" in any order.
    [
        /claude.*4[._-]?[67].*(opus|sonnet)/i,
        { context: 1000000, output: 128000 },
    ],
    [
        /claude.*(opus|sonnet).*4[._-]?[67]/i,
        { context: 1000000, output: 128000 },
    ],
    // Older opus 4.5/4.x: 200K.
    [/claude.*opus.*4[._-]?5/i, { context: 200000, output: 64000 }],
    [/claude.*opus.*4[._-]?[01]/i, { context: 200000, output: 32000 }],
    // Haiku 4.5: 200K ctx / 64K out (verified live 200K ok, 210K fail). Id may
    // order either way (claude-haiku-4-5 or claude-4-5-haiku).
    [
        /claude.*haiku.*4[._-]?5|claude.*4[._-]?5.*haiku/i,
        { context: 200000, output: 64000 },
    ],
    [/claude.*sonnet.*4[._-]?5/i, { context: 200000, output: 64000 }],
    [/claude.*sonnet.*4/i, { context: 200000, output: 16000 }],
    [/claude/i, { context: 200000, output: 16000 }],
    // gpt-5.6 (sol/luna/terra): catalog advertises 1.05M ctx / 128K out.
    [/gpt.?5\.6/i, { context: 1050000, output: 128000 }],
    // gpt-oss-120b: 128K ctx / 128K out (catalog + live).
    [/gpt.?oss/i, { context: 128000, output: 128000 }],
    [/gpt.*5/i, { context: 1000000, output: 100000 }],
    [/gpt.*4o/i, { context: 128000, output: 16384 }],
    [/gpt.*4/i, { context: 128000, output: 8192 }],
    // llama4-maverick on this deployment accepts 1M live (catalog bedrock entry
    // is stale at 128K).
    [/llama.*4.*maverick/i, { context: 1000000, output: 8192 }],
    [/llama.*4/i, { context: 131072, output: 16384 }],
    [/llama.*3/i, { context: 131072, output: 8192 }],
    [/gemma.*3/i, { context: 128000, output: 131072 }],
    [/gemini.*2/i, { context: 1048576, output: 65536 }],
    [/nova.*pro/i, { context: 300000, output: 10000 }],
    [/nova.*lite/i, { context: 300000, output: 5000 }],
];
const DEFAULT_LIMITS: ModelLimits = { context: 128000, output: 16384 };

export function inferModelLimits(
    modelId: string,
    modelName: string,
): ModelLimits {
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
const CLAUDE_EFFORTS_BASE = ["low", "medium", "high", "max"] as const;
const CLAUDE_EFFORTS_XHIGH = ["low", "medium", "high", "xhigh", "max"] as const;
// xhigh effort is opus-4-7 / mythos only per Anthropic v2.1.137 CLI (E5$ fn).
const CLAUDE_MODELS_WITH_XHIGH = /claude.*(opus.*4[._-]?7|mythos)/i;
const CLAUDE_MODELS_WITH_ADAPTIVE_THINKING =
    /claude.*(sonnet|opus|haiku|mythos).*(4[._-]?[56789]|[5-9][._-]?[0-9]|preview)/i;

export function buildClaudeVariants(modelId: string): Record<string, unknown> {
    if (!CLAUDE_MODELS_WITH_ADAPTIVE_THINKING.test(modelId)) {
        return {
            high: { thinking: { type: "enabled", budgetTokens: 16000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31999 } },
        };
    }
    const isOpus47 = CLAUDE_MODELS_WITH_XHIGH.test(modelId);
    const efforts = isOpus47 ? CLAUDE_EFFORTS_XHIGH : CLAUDE_EFFORTS_BASE;
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
    );
}
