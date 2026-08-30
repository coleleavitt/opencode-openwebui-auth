import {
    buildClaudeVariants,
    inferModelLimits,
    type OpenWebUIModelInfo,
} from "@openwebui-auth/core";

/**
 * Build an opencode provider Model entry from an OWUI /api/models item.
 * opencode-specific: emits opencode's provider schema (providerID, npm adapter,
 * zeroed cost, capability flags, and Claude reasoning variants).
 */
export function buildOpencodeModel(
    providerID: string,
    baseUrl: string,
    npm: string,
    raw: OpenWebUIModelInfo,
): Record<string, unknown> {
    const caps = raw.info?.meta?.capabilities ?? {};
    const limits = inferModelLimits(raw.id, raw.name ?? "");
    const isClaude = /claude/i.test(raw.id);
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
            // Claude models support adaptive thinking. Non-Claude models go
            // through the generic openai-compatible path (reasoningEffort).
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
