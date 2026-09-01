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
    // Output was 131072 — the context limit duplicated. Impossible as an output
    // cap, and max_tokens=131072 does 400 live; 8192 is Gemma 3's real ceiling.
    [/gemma.*3/i, { context: 128000, output: 8192 }],
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

const CLAUDE_EFFORTS_BASE = ["low", "medium", "high", "max"] as const;
const CLAUDE_EFFORTS_XHIGH = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Claude generation as a number (`claude-5-opus` -> 5, `claude-opus-4-6` -> 4.6).
 *
 * Ids order family and version either way, so parse rather than pattern-match:
 * a regex anchored on one order silently misses the other and drops the model
 * onto the legacy thinking path, which Claude 5 rejects outright. Date stamps
 * are stripped first or `claude-sonnet-4-20250514` reads as generation 4.2.
 */
function claudeGeneration(modelId: string): number | null {
    const match = modelId
        .replace(/\d{6,}/g, "")
        .match(/claude\D*(\d)(?:[._-](\d))?/i);
    if (!match) return null;
    return Number(match[2] ? `${match[1]}.${match[2]}` : match[1]);
}

/**
 * Thinking params per effort level, keyed by effort name.
 *
 * Shape is dictated by the provider, which rejects everything else (verified
 * live against this deployment):
 *   - `thinking.type: "enabled"` 400s on Claude 5 — "use thinking.type.adaptive
 *     and output_config.effort". Legacy is only safe below 4.6.
 *   - effort belongs in `output_config`; top-level or nested under `thinking`
 *     both 400 with "Extra inputs are not permitted".
 *   - Haiku accepts adaptive but no effort at all ("This model does not support
 *     the effort parameter"), so its levels must carry thinking only.
 * xhigh is opus 4.6+ and any 5.x; sonnet 4.6 rejects it.
 */
export function buildClaudeVariants(modelId: string): Record<string, unknown> {
    const generation = claudeGeneration(modelId);
    const isMythos = /mythos/i.test(modelId);
    const family = /opus|sonnet|haiku/i.exec(modelId)?.[0].toLowerCase();

    if (!isMythos && (generation === null || generation < 4.5)) {
        return {
            high: { thinking: { type: "enabled", budgetTokens: 16000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31999 } },
        };
    }

    const generationOf = generation ?? 0;
    // Summarized display keeps reasoning traces from dominating multi-turn
    // context on the models that emit the longest ones.
    const thinking = {
        type: "adaptive",
        ...(isMythos || (family === "opus" && generationOf >= 4.7)
            ? { display: "summarized" }
            : {}),
    };

    if (family === "haiku") {
        return { high: { thinking }, max: { thinking } };
    }

    const supportsXhigh =
        isMythos ||
        (family === "opus" ? generationOf >= 4.6 : generationOf >= 5);
    const efforts = supportsXhigh ? CLAUDE_EFFORTS_XHIGH : CLAUDE_EFFORTS_BASE;
    return Object.fromEntries(
        efforts.map((effort) => [
            effort,
            { thinking, output_config: { effort } },
        ]),
    );
}
