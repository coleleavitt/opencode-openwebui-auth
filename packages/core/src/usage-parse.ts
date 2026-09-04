// Extract token usage from an OpenAI-compatible streaming (SSE) response body.
// OWUI/LiteLLM emit a final chunk carrying `"usage": { prompt_tokens, ...}` when
// `stream_options.include_usage` is set. Shared so the opencode fetch shim and
// the pi streamSimple both account usage identically.

export interface ParsedUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

interface UsageObject {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        cache_write_tokens?: number;
        cache_creation_tokens?: number;
    };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cached_tokens?: number;
}

function toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}

/** Map one OpenAI/LiteLLM usage object onto the shared shape. */
export function parseUsageObject(usage: unknown): ParsedUsage | undefined {
    if (!usage || typeof usage !== "object") return undefined;
    const obj = usage as UsageObject;
    if (typeof obj.completion_tokens !== "number") return undefined;
    const details = obj.prompt_tokens_details;
    return {
        input: toCount(obj.prompt_tokens),
        output: toCount(obj.completion_tokens),
        // LiteLLM reports Bedrock cache reads in prompt_tokens_details.cached_tokens
        // and (newer builds) also as top-level cache_read_input_tokens.
        cacheRead: toCount(
            details?.cached_tokens ??
                obj.cache_read_input_tokens ??
                obj.cached_tokens,
        ),
        cacheWrite: toCount(
            details?.cache_write_tokens ??
                details?.cache_creation_tokens ??
                obj.cache_creation_input_tokens,
        ),
    };
}

/**
 * Pull the last usage object out of an accumulated SSE text buffer.
 * Returns undefined when no usage block is present. Frames are parsed as JSON
 * (a regex cannot stop at the right brace once `*_tokens_details` nests).
 */
export function parseUsageFromBuffer(buffer: string): ParsedUsage | undefined {
    let last: ParsedUsage | undefined;
    for (const line of buffer.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:") || !trimmed.includes('"usage"'))
            continue;
        try {
            const parsed = JSON.parse(trimmed.slice(5)) as { usage?: unknown };
            const usage = parseUsageObject(parsed.usage);
            if (usage) last = usage;
        } catch {
            // a partial trailing frame; the caller's buffer tail may cut it
        }
    }
    if (last) return last;
    // Fallback for a buffer whose head was truncated mid-frame: locate the
    // last usage object by brace matching.
    const idx = buffer.lastIndexOf('"usage"');
    if (idx === -1) return undefined;
    const start = buffer.indexOf("{", idx);
    if (start === -1) return undefined;
    let depth = 0;
    for (let i = start; i < buffer.length; i++) {
        if (buffer[i] === "{") depth++;
        else if (buffer[i] === "}" && --depth === 0) {
            try {
                return parseUsageObject(JSON.parse(buffer.slice(start, i + 1)));
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}
