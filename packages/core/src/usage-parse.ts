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

/**
 * Pull the last usage object out of an accumulated SSE text buffer.
 * Returns undefined when no usage block is present.
 */
export function parseUsageFromBuffer(buffer: string): ParsedUsage | undefined {
    const matches = [
        ...buffer.matchAll(
            /"usage"\s*:\s*\{[^}]*"completion_tokens"\s*:\s*(\d+)[^}]*\}/g,
        ),
    ];
    const match = matches.length > 0 ? matches[matches.length - 1] : null;
    if (!match) return undefined;

    const block = match[0];
    const prompt = block.match(/"prompt_tokens"\s*:\s*(\d+)/);
    const completion = block.match(/"completion_tokens"\s*:\s*(\d+)/);
    const cached = block.match(/"cached_tokens"\s*:\s*(\d+)/);
    return {
        input: prompt ? Number.parseInt(prompt[1], 10) : 0,
        output: completion ? Number.parseInt(completion[1], 10) : 0,
        cacheRead: cached ? Number.parseInt(cached[1], 10) : 0,
        cacheWrite: 0,
    };
}
