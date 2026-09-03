import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEventStream,
    type Context,
    calculateCost,
    createAssistantMessageEventStream,
    type Model,
    type SimpleStreamOptions,
    type StopReason,
    type TextContent,
    type ThinkingContent,
    type ToolCall,
} from "@earendil-works/pi-ai";
import {
    AUTH_RETRY_STATUSES,
    isRetryableErrorBody,
    log,
    MAX_RETRIES,
    nextRetryDelayMs,
    oidcLogin,
    parseUsageFromBuffer,
    RATE_LIMIT_STATUS,
    RETRY_STATUSES,
    Storage,
} from "@openwebui-auth/core";

import { buildOpenAIRequest } from "./convert";

const SAFETY_TIMEOUT_MS = 10 * 60 * 1000;

/** Reasoning delta field names, most specific first; the first match wins. */
const REASONING_FIELDS = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
] as const;

interface OpenAIStreamDelta {
    role?: string;
    content?: string | null;
    // LiteLLM/Bedrock returns the reasoning trace out-of-band from `content`.
    // Field name varies by upstream, so all three known spellings are read.
    reasoning_content?: string | null;
    reasoning?: string | null;
    reasoning_text?: string | null;
    tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
    }>;
}

interface ToolCallAccumulator {
    contentIndex: number;
    id: string;
    name: string;
    argsBuffer: string;
}

function mapFinishReason(reason: string | null | undefined): StopReason {
    switch (reason) {
        case "length":
            return "length";
        case "tool_calls":
        case "function_call":
            return "toolUse";
        case "stop":
        case "end_turn":
            return "stop";
        default:
            return "stop";
    }
}

/**
 * Custom streamSimple for the OWUI (Shibboleth OIDC) provider.
 *
 * OWUI proxies to LiteLLM -> Bedrock, so this mirrors the opencode fetch shim:
 *  - build a Bedrock-safe OpenAI request (core request-shaping),
 *  - retry 429 (Retry-After) / 5xx / LiteLLM-mislabeled-400 (core retry-policy),
 *  - re-auth on 401/403 via the OIDC flow when env credentials are present,
 *  - parse the OpenAI SSE stream into pi AssistantMessage events,
 *  - account token usage into the shared account store (core usage-parse).
 */
export function streamOpenWebUI(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();

    (async () => {
        const output: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                },
            },
            stopReason: "pending",
            timestamp: Date.now(),
        };

        const storage = new Storage();
        let account = storage.getCurrent();
        let token = options?.apiKey ?? account?.token ?? "";
        const baseUrl = (account?.baseUrl ?? model.baseUrl).replace(
            /\/api$/,
            "",
        );
        const url = `${baseUrl}/api/chat/completions`;

        const body = buildOpenAIRequest(model.id, context, {
            maxTokens: options?.maxTokens ?? Math.floor(model.maxTokens / 3),
            temperature: options?.temperature,
            reasoning: options?.reasoning,
            supportsReasoning: model.reasoning,
        });
        const payload = JSON.stringify(body);

        const safetySignal = AbortSignal.timeout(SAFETY_TIMEOUT_MS);
        const signals: AbortSignal[] = [safetySignal];
        if (options?.signal) signals.push(options.signal);
        const signal =
            signals.length === 1 ? signals[0] : AbortSignal.any(signals);

        try {
            let res: Response | undefined;
            let didAuthRetry = false;

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                if (attempt > 0 && res) {
                    const delay = nextRetryDelayMs(
                        res,
                        attempt,
                        res.headers.get("x-should-retry"),
                    );
                    if (delay !== undefined) {
                        log(
                            `[pi-stream] retry #${attempt} in ${Math.round(delay)}ms after ${res.status}`,
                        );
                        await new Promise((r) => setTimeout(r, delay));
                    }
                }

                res = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "text/event-stream",
                        Authorization: `Bearer ${token}`,
                    },
                    body: payload,
                    signal,
                });
                await options?.onResponse?.(res as never, model);

                if (res.ok) break;

                // 401/403 -> re-auth once via OIDC (needs env credentials).
                if (AUTH_RETRY_STATUSES.has(res.status) && !didAuthRetry) {
                    didAuthRetry = true;
                    const refreshed = await reauth(baseUrl).catch(
                        () => undefined,
                    );
                    if (refreshed) {
                        token = refreshed;
                        account = storage.getCurrent();
                        attempt--; // this attempt doesn't count
                        continue;
                    }
                }

                // LiteLLM sometimes mislabels a transient Bedrock 503 as 400.
                if (
                    res.status === 400 &&
                    attempt < MAX_RETRIES &&
                    isRetryableErrorBody(await peekBody(res))
                ) {
                    continue;
                }

                const retryable =
                    res.status === RATE_LIMIT_STATUS ||
                    RETRY_STATUSES.has(res.status);
                if (!retryable || attempt >= MAX_RETRIES) break;
            }

            if (!res?.ok || !res.body) {
                const detail = res
                    ? `${res.status} ${await peekBody(res)}`
                    : "no response";
                throw new Error(`OpenWebUI request failed: ${detail}`);
            }

            stream.push({ type: "start", partial: output });

            const finishReason = await consumeSse(
                res.body,
                stream,
                output,
                model,
            );

            // Account usage into the shared store (best effort).
            if (account && output.usage.totalTokens > 0) {
                await storage
                    .addUsage(account.name, {
                        input: output.usage.input,
                        output: output.usage.output,
                        cacheRead: output.usage.cacheRead,
                        cacheWrite: output.usage.cacheWrite,
                        model: model.id,
                    })
                    .catch(() => {});
            }

            output.stopReason = finishReason;
            stream.push({
                type: "done",
                reason: finishReason as Extract<
                    StopReason,
                    "stop" | "length" | "toolUse" | "deferred"
                >,
                message: output,
            });
            stream.end(output);
        } catch (err) {
            const aborted =
                err instanceof Error &&
                (err.name === "AbortError" || err.message.includes("aborted"));
            output.stopReason = aborted ? "aborted" : "error";
            output.errorMessage =
                err instanceof Error ? err.message : String(err);
            stream.push({
                type: "error",
                reason: output.stopReason as Extract<
                    StopReason,
                    "aborted" | "error"
                >,
                error: output,
            });
            stream.end(output);
        }
    })();

    return stream;
}

/** Read a bounded slice of a failed response body without disturbing success paths. */
async function peekBody(res: Response): Promise<string> {
    try {
        return (await res.clone().text()).slice(0, 500);
    } catch {
        return "";
    }
}

/** Re-run the OIDC login using env credentials; returns a fresh token or throws. */
async function reauth(baseUrl: string): Promise<string> {
    const username = process.env.OWUI_USERNAME?.trim();
    const password = process.env.OWUI_PASSWORD;
    if (!username || !password) {
        throw new Error(
            "token expired and no OWUI_USERNAME/OWUI_PASSWORD for re-auth",
        );
    }
    const result = await oidcLogin({
        baseUrl,
        username,
        password,
        duoMethod: process.env.OWUI_DUO_PASSCODE ? "passcode" : "push",
        duoPasscode: process.env.OWUI_DUO_PASSCODE,
    });
    const storage = new Storage();
    const current = storage.getCurrent();
    if (current) {
        await storage.upsert({
            ...current,
            token: result.token,
            expiresAt: result.expiresAt,
            updatedAt: Date.now(),
        });
    }
    return result.token;
}

/**
 * Parse an OpenAI-compatible SSE stream, emitting pi text/tool events onto
 * `stream` and mutating `output` in place. Returns the final stop reason.
 */
async function consumeSse(
    bodyStream: ReadableStream<Uint8Array>,
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    model: Model<Api>,
): Promise<StopReason> {
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usageBuffer = "";
    let finishReason: StopReason = "stop";

    let textIndex = -1;
    let thinkingIndex = -1;
    const toolCalls = new Map<number, ToolCallAccumulator>();

    // The trace arrives before the answer, so its block is opened first and the
    // signature records which upstream field supplied it (round-trip fidelity).
    const ensureThinkingBlock = (signature: string) => {
        if (thinkingIndex === -1) {
            output.content.push({
                type: "thinking",
                thinking: "",
                thinkingSignature: signature,
            } as ThinkingContent);
            thinkingIndex = output.content.length - 1;
            stream.push({
                type: "thinking_start",
                contentIndex: thinkingIndex,
                partial: output,
            });
        }
    };

    const ensureTextBlock = () => {
        if (textIndex === -1) {
            output.content.push({ type: "text", text: "" } as TextContent);
            textIndex = output.content.length - 1;
            stream.push({
                type: "text_start",
                contentIndex: textIndex,
                partial: output,
            });
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            buffer += text;
            usageBuffer += text;
            if (usageBuffer.length > 8192)
                usageBuffer = usageBuffer.slice(-8192);

            let nl: number;
            // biome-ignore lint/suspicious/noAssignInExpressions: SSE line split
            while ((nl = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") continue;

                let chunk: {
                    choices?: Array<{
                        delta?: OpenAIStreamDelta;
                        finish_reason?: string | null;
                    }>;
                };
                try {
                    chunk = JSON.parse(data);
                } catch {
                    continue;
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;
                const delta = choice.delta ?? {};

                for (const field of REASONING_FIELDS) {
                    const reasoning = delta[field];
                    if (typeof reasoning !== "string" || reasoning.length === 0)
                        continue;
                    ensureThinkingBlock(field);
                    (
                        output.content[thinkingIndex] as ThinkingContent
                    ).thinking += reasoning;
                    stream.push({
                        type: "thinking_delta",
                        contentIndex: thinkingIndex,
                        delta: reasoning,
                        partial: output,
                    });
                    break;
                }

                if (
                    typeof delta.content === "string" &&
                    delta.content.length > 0
                ) {
                    ensureTextBlock();
                    (output.content[textIndex] as TextContent).text +=
                        delta.content;
                    stream.push({
                        type: "text_delta",
                        contentIndex: textIndex,
                        delta: delta.content,
                        partial: output,
                    });
                }

                for (const tc of delta.tool_calls ?? []) {
                    let acc = toolCalls.get(tc.index);
                    if (!acc) {
                        output.content.push({
                            type: "toolCall",
                            id: tc.id ?? `call_${tc.index}`,
                            name: tc.function?.name ?? "",
                            arguments: {},
                        } as ToolCall);
                        acc = {
                            contentIndex: output.content.length - 1,
                            id: tc.id ?? `call_${tc.index}`,
                            name: tc.function?.name ?? "",
                            argsBuffer: "",
                        };
                        toolCalls.set(tc.index, acc);
                        stream.push({
                            type: "toolcall_start",
                            contentIndex: acc.contentIndex,
                            partial: output,
                        });
                    }
                    if (tc.function?.name) acc.name = tc.function.name;
                    if (tc.function?.arguments) {
                        acc.argsBuffer += tc.function.arguments;
                        stream.push({
                            type: "toolcall_delta",
                            contentIndex: acc.contentIndex,
                            delta: tc.function.arguments,
                            partial: output,
                        });
                    }
                }

                if (choice.finish_reason) {
                    finishReason = mapFinishReason(choice.finish_reason);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    // Finalize thinking + text + tool-call blocks.
    if (thinkingIndex !== -1) {
        const thinking = (output.content[thinkingIndex] as ThinkingContent)
            .thinking;
        stream.push({
            type: "thinking_end",
            contentIndex: thinkingIndex,
            content: thinking,
            partial: output,
        });
    }
    if (textIndex !== -1) {
        const content = (output.content[textIndex] as TextContent).text;
        stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content,
            partial: output,
        });
    }
    for (const acc of toolCalls.values()) {
        let args: Record<string, unknown> = {};
        try {
            args = acc.argsBuffer ? JSON.parse(acc.argsBuffer) : {};
        } catch {
            args = {};
        }
        const toolCall = output.content[acc.contentIndex] as ToolCall;
        toolCall.name = acc.name;
        toolCall.arguments = args;
        stream.push({
            type: "toolcall_end",
            contentIndex: acc.contentIndex,
            toolCall,
            partial: output,
        });
    }

    // Usage (from the final include_usage chunk).
    const usage = parseUsageFromBuffer(usageBuffer);
    if (usage) {
        output.usage.input = usage.input;
        output.usage.output = usage.output;
        output.usage.cacheRead = usage.cacheRead;
        output.usage.cacheWrite = usage.cacheWrite;
        output.usage.totalTokens =
            usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        output.usage.cost = calculateCost(model, output.usage);
    }

    if (toolCalls.size > 0 && finishReason === "stop") finishReason = "toolUse";
    return finishReason;
}
