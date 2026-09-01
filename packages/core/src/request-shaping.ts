// OWUI/LiteLLM+Bedrock request-body shaping shared by every host adapter.
//
// The OWUI proxy forwards chat/completions to LiteLLM -> Bedrock, which rejects
// several shapes the OpenAI wire format otherwise permits: empty text blocks,
// tool metadata when no tools are declared, and old-style function-calling
// fields. These helpers normalize a parsed request body in place so any adapter
// (opencode fetch shim, pi streamSimple) produces a Bedrock-safe request.

const BLANK_TEXT_PLACEHOLDER = ".";

const DUMMY_TOOL = {
    type: "function",
    function: {
        name: "dummy_tool",
        description: "placeholder tool — never call",
        parameters: { type: "object", properties: {} },
    },
};

/** True if the conversation history references tool calls or tool-role messages. */
export function messagesReferenceTools(messages: unknown): boolean {
    if (!Array.isArray(messages)) return false;
    for (const msg of messages) {
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        if (m.role === "tool") return true;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
        if (Array.isArray(m.content)) {
            for (const block of m.content as unknown[]) {
                if (
                    block &&
                    typeof block === "object" &&
                    ((block as Record<string, unknown>).type === "tool_use" ||
                        (block as Record<string, unknown>).type ===
                            "tool_result")
                ) {
                    return true;
                }
            }
        }
    }
    return false;
}

export function sanitizeContentBlock(block: unknown): unknown {
    if (!block || typeof block !== "object") return block;
    const b = block as Record<string, unknown>;

    // Anthropic-native `tool_result` blocks wrap a nested content array. The
    // top-level pass would skip past these without sanitizing the text blocks
    // inside, so recurse explicitly.
    if (b.type === "tool_result" && Array.isArray(b.content)) {
        const inner = (b.content as unknown[]).map(sanitizeContentBlock);
        return {
            ...b,
            content:
                inner.length === 0
                    ? [{ type: "text", text: BLANK_TEXT_PLACEHOLDER }]
                    : inner,
        };
    }

    if (
        b.type === "text" &&
        (typeof b.text !== "string" || b.text.trim() === "")
    ) {
        return { ...b, text: BLANK_TEXT_PLACEHOLDER };
    }
    return b;
}

export function sanitizeMessageContent(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    const content = m.content;

    if (typeof content === "string") {
        if (content.trim() === "") m.content = BLANK_TEXT_PLACEHOLDER;
        return;
    }

    if (Array.isArray(content)) {
        const sanitized = content.map(sanitizeContentBlock);
        m.content =
            sanitized.length === 0
                ? [{ type: "text", text: BLANK_TEXT_PLACEHOLDER }]
                : sanitized;
        return;
    }

    // content === null / undefined is valid for assistant turns that have only
    // tool_calls; Bedrock accepts those. Anything else (numbers, booleans, …)
    // is malformed by the caller and not our problem to coerce.
}

export function sanitizeBedrockContent(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const obj = body as Record<string, unknown>;

    // `system` may be a plain string or an Anthropic-style ContentBlock[]. The
    // array form was previously skipped — empty text blocks inside it would
    // bypass sanitation and reach Bedrock unchanged.
    if (Array.isArray(obj.system)) {
        const inner = (obj.system as unknown[]).map(sanitizeContentBlock);
        obj.system =
            inner.length === 0
                ? [{ type: "text", text: BLANK_TEXT_PLACEHOLDER }]
                : inner;
    } else if (typeof obj.system === "string" && obj.system.trim() === "") {
        obj.system = BLANK_TEXT_PLACEHOLDER;
    }

    const messages = obj.messages;
    if (Array.isArray(messages)) {
        for (const msg of messages) sanitizeMessageContent(msg);
    }
}

const ORPHANED_TOOL_CALL_RESULT =
    "Error: no result was recorded for this tool call — the host exited before it returned.";

/**
 * Give every `tool_calls` entry a matching tool-role reply.
 *
 * Bedrock hard-rejects an assistant turn whose tool call never got an output
 * ("No tool output found for function call <id>"), and a transcript only has to
 * lose one result to earn that 400 on every later request — a crashed host mid
 * tool call permanently wedges the session, since each retry replays the same
 * gap. Synthesizing the missing reply is what makes the history sendable again;
 * an errored result is honest about what happened and lets the model retry.
 *
 * Replies must sit directly after their assistant turn, so each insert goes at
 * the end of that turn's existing run of tool messages rather than at the end
 * of the conversation.
 */
export function repairDanglingToolCalls(body: unknown): unknown {
    if (!body || typeof body !== "object") return body;
    const obj = body as Record<string, unknown>;
    const messages = obj.messages;
    if (!Array.isArray(messages)) return body;

    const repaired: unknown[] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        repaired.push(msg);
        if (!msg || typeof msg !== "object") continue;
        const m = msg as Record<string, unknown>;
        if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;

        const answered = new Set<string>();
        while (i + 1 < messages.length) {
            const next = messages[i + 1];
            if (!next || typeof next !== "object") break;
            const n = next as Record<string, unknown>;
            if (n.role !== "tool") break;
            if (typeof n.tool_call_id === "string")
                answered.add(n.tool_call_id);
            repaired.push(next);
            i++;
        }

        for (const call of m.tool_calls as unknown[]) {
            if (!call || typeof call !== "object") continue;
            const id = (call as Record<string, unknown>).id;
            if (typeof id !== "string" || answered.has(id)) continue;
            repaired.push({
                role: "tool",
                tool_call_id: id,
                content: ORPHANED_TOOL_CALL_RESULT,
            });
        }
    }

    obj.messages = repaired;
    return obj;
}

/** Strip/repair tool-related fields Bedrock rejects. Returns the same object. */
export function scrubBedrockToolFields(body: unknown): unknown {
    if (!body || typeof body !== "object") return body;
    const obj = body as Record<string, unknown>;
    const tools = obj.tools;
    const hasTools = Array.isArray(tools) && tools.length > 0;

    if (!hasTools) {
        if ("tools" in obj) delete obj.tools;
        if ("tool_choice" in obj) delete obj.tool_choice;
        if ("parallel_tool_calls" in obj) delete obj.parallel_tool_calls;

        // LiteLLM+Bedrock also rejects if the *conversation history* contains
        // tool calls or tool-role messages, even when the request declares no
        // tools. Equivalent of litellm_settings::modify_params=True: inject a
        // dummy tool so validation passes. The model never calls it.
        if (messagesReferenceTools(obj.messages)) {
            obj.tools = [DUMMY_TOOL];
        }
    } else {
        const choice = obj.tool_choice;
        const choiceType =
            typeof choice === "object" && choice !== null
                ? (choice as { type?: string }).type
                : typeof choice === "string"
                  ? choice
                  : undefined;

        if (choiceType === "none") {
            // Bedrock does not support tool_choice:"none" — drop tools for
            // this turn so the model just generates free text.
            delete obj.tools;
            delete obj.tool_choice;
            delete obj.parallel_tool_calls;
        } else if (choiceType === "any" || choiceType === "required") {
            // Bedrock supports "auto" and specific tool choice; coerce
            // "any"/"required" to "auto" (closest semantic equivalent).
            obj.tool_choice = "auto";
        }
    }

    // Old-style OpenAI function-calling API — Bedrock chokes on these.
    if ("functions" in obj) delete obj.functions;
    if ("function_call" in obj) delete obj.function_call;
    return obj;
}

/**
 * Apply the full Bedrock-safety pass to a parsed request body, in place.
 * Order matters: repair dangling tool calls first so the synthesized replies are
 * visible to the tool-reference scan, then scrub tool fields (may inject a dummy
 * tool), then sanitize blank content. Returns the same object for convenience.
 */
export function shapeBedrockRequestBody(
    body: Record<string, unknown>,
): Record<string, unknown> {
    repairDanglingToolCalls(body);
    scrubBedrockToolFields(body);
    sanitizeBedrockContent(body);
    return body;
}
