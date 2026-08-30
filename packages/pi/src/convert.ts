import { shapeBedrockRequestBody } from "@openwebui-auth/core";
import type {
    Context,
    ImageContent,
    Message,
    TextContent,
    ThinkingContent,
    Tool,
    ToolCall,
    ToolResultMessage,
} from "@earendil-works/pi-ai";

/** An OpenAI chat/completions request body (the subset we build). */
export interface OpenAIChatRequest {
    model: string;
    messages: Array<Record<string, unknown>>;
    stream: true;
    stream_options: { include_usage: true };
    max_tokens?: number;
    temperature?: number;
    tools?: Array<Record<string, unknown>>;
    reasoning_effort?: string;
    [key: string]: unknown;
}

function textOf(block: TextContent | ImageContent | ThinkingContent): string {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return block.thinking;
    return "";
}

/** OWUI/OpenAI content parts for a user/tool message that may include images. */
function toOpenAIContentParts(
    content: (TextContent | ImageContent)[],
): Array<Record<string, unknown>> {
    return content.map((part) => {
        if (part.type === "image") {
            return {
                type: "image_url",
                image_url: {
                    url: `data:${part.mimeType};base64,${part.data}`,
                },
            };
        }
        return { type: "text", text: part.text };
    });
}

function toOpenAIToolCall(call: ToolCall): Record<string, unknown> {
    return {
        id: call.id,
        type: "function",
        function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments ?? {}),
        },
    };
}

/** Convert one pi Message into one-or-more OpenAI chat messages. */
function convertMessage(message: Message): Array<Record<string, unknown>> {
    if (message.role === "user") {
        const content =
            typeof message.content === "string"
                ? message.content
                : toOpenAIContentParts(message.content);
        return [{ role: "user", content }];
    }

    if (message.role === "assistant") {
        const text = message.content
            .filter((b): b is TextContent => b.type === "text")
            .map(textOf)
            .join("");
        const toolCalls = message.content
            .filter((b): b is ToolCall => b.type === "toolCall")
            .map(toOpenAIToolCall);
        const out: Record<string, unknown> = { role: "assistant" };
        out.content = text.length > 0 ? text : null;
        if (toolCalls.length > 0) out.tool_calls = toolCalls;
        return [out];
    }

    // toolResult -> OpenAI "tool" role message keyed by tool_call_id.
    const tr = message as ToolResultMessage;
    const text = tr.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
    return [
        {
            role: "tool",
            tool_call_id: tr.toolCallId,
            content: text.length > 0 ? text : ".",
        },
    ];
}

function convertTools(tools: Tool[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters ?? { type: "object", properties: {} },
        },
    }));
}

// pi reasoning level -> OpenAI reasoning_effort.
//
// DISABLED by default: this OWUI/LiteLLM+Bedrock deployment translates
// reasoning_effort into a Bedrock `thinking` param, which most models here reject
// ("Unknown parameter: 'thinking'" — gpt-5.6, claude-haiku, gemma). Models still
// reason natively without it. Opt back in per-request only when a model is known
// to accept it, gated by OWUI_SEND_REASONING_EFFORT=1.
function reasoningEffort(level: string | undefined): string | undefined {
    if (!level) return undefined;
    if (process.env.OWUI_SEND_REASONING_EFFORT !== "1") return undefined;
    const map: Record<string, string> = {
        minimal: "minimal",
        low: "low",
        medium: "medium",
        high: "high",
        max: "high",
    };
    return map[level] ?? undefined;
}

export interface BuildRequestOptions {
    maxTokens?: number;
    temperature?: number;
    reasoning?: string;
    supportsReasoning?: boolean;
}

/**
 * Build a Bedrock-safe OpenAI chat request from a pi Context. Reuses core's
 * request-shaping (blank-text sanitizing + tool-field scrubbing) so pi and the
 * opencode plugin send upstream the exact same normalized shape.
 */
export function buildOpenAIRequest(
    modelId: string,
    context: Context,
    options: BuildRequestOptions = {},
): OpenAIChatRequest {
    const messages: Array<Record<string, unknown>> = [];
    if (context.systemPrompt) {
        messages.push({ role: "system", content: context.systemPrompt });
    }
    for (const message of context.messages) {
        messages.push(...convertMessage(message));
    }

    const body: OpenAIChatRequest = {
        model: modelId,
        messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;
    if (typeof options.temperature === "number") {
        body.temperature = options.temperature;
    }
    if (context.tools && context.tools.length > 0) {
        body.tools = convertTools(context.tools);
    }
    const effort = options.supportsReasoning
        ? reasoningEffort(options.reasoning)
        : undefined;
    if (effort) body.reasoning_effort = effort;

    return shapeBedrockRequestBody(
        body as unknown as Record<string, unknown>,
    ) as unknown as OpenAIChatRequest;
}
