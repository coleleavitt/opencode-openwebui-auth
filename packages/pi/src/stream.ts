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
    backoffDelayMs,
    carriedNoContent,
    classifySseFrame,
    formatStreamDiagnostics,
    isRetryableErrorBody,
    isRetryableStreamError,
    isTransientNetworkError,
    log,
    logDebugArtifact,
    logStream,
    maxRetries,
    newStreamDiagnostics,
    nextRetryDelayMs,
    normalizeStreamError,
    type OpenAIChunk,
    oidcLogin,
    parseUsageFromBuffer,
    RATE_LIMIT_STATUS,
    RETRY_STATUSES,
    reachedTerminalFrame,
    recordFrame,
    Storage,
    type StreamDiagnostics,
    truncateForLog,
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
    refusal?: string | null;
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
        case "content_filter":
            return "error";
        default:
            return "stop";
    }
}

/**
 * A completion attempt that must not be reported as a successful assistant
 * message. `retryable` means the request may be re-sent (only ever honored
 * when nothing has been emitted to the consumer yet); `authSuspect` means the
 * response looked like a login/SPA page, so a re-auth is worth one try.
 */
class StreamFailure extends Error {
    constructor(
        message: string,
        readonly kind:
            | "error-frame"
            | "truncated"
            | "empty"
            | "content-filter"
            | "unexpected-content-type"
            | "json-error",
        readonly retryable: boolean,
        readonly authSuspect = false,
    ) {
        super(message);
        this.name = "StreamFailure";
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
 *  - refuse to settle an error frame, a truncated body or an empty completion
 *    as success (LiteLLM reports post-start failures inside a 200 stream),
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

        // Hidden reasoning counts against max_tokens on Bedrock gpt-5.x: a
        // budget the model spends entirely on reasoning ends with
        // finish_reason=length and no text. Start from the caller's budget and
        // grow it once, up to the model cap, when that happens.
        let maxTokens = Math.min(
            options?.maxTokens ?? Math.floor(model.maxTokens / 3),
            model.maxTokens,
        );
        const buildPayload = () =>
            buildOpenAIRequest(model.id, context, {
                maxTokens,
                temperature: options?.temperature,
                reasoning: options?.reasoning,
                supportsReasoning: model.reasoning,
            });
        let body = buildPayload();
        let payload = JSON.stringify(body);
        const requestId = Math.random().toString(36).slice(2, 10);
        const tag = `req=${requestId} model=${model.id} msgs=${body.messages.length} tools=${body.tools?.length ?? 0}`;
        const retryBudget = maxRetries();

        const safetySignal = AbortSignal.timeout(SAFETY_TIMEOUT_MS);
        const signals: AbortSignal[] = [safetySignal];
        if (options?.signal) signals.push(options.signal);
        const signal =
            signals.length === 1 ? signals[0] : AbortSignal.any(signals);

        let didAuthRetry = false;

        const tryReauth = async (): Promise<boolean> => {
            if (didAuthRetry) return false;
            didAuthRetry = true;
            const refreshed = await reauth(baseUrl).catch((err) => {
                log(
                    `[pi-stream] ${tag} re-auth failed: ${truncateForLog(err instanceof Error ? err.message : String(err))}`,
                );
                return undefined;
            });
            if (!refreshed) return false;
            token = refreshed;
            account = storage.getCurrent();
            return true;
        };

        /** Run the HTTP-level retry loop; resolves with an OK response or throws. */
        const fetchOk = async (): Promise<Response> => {
            let res: Response | undefined;
            let networkFailures = 0;
            for (let attempt = 0; attempt <= retryBudget; attempt++) {
                if (attempt > 0 && res) {
                    const delay = nextRetryDelayMs(
                        res,
                        attempt,
                        res.headers.get("x-should-retry"),
                    );
                    if (delay !== undefined) {
                        log(
                            `[pi-stream] ${tag} retry #${attempt} in ${Math.round(delay)}ms after ${res.status}`,
                        );
                        await new Promise((r) => setTimeout(r, delay));
                    }
                }

                const started = Date.now();
                try {
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
                } catch (err) {
                    if (
                        !isTransientNetworkError(err) ||
                        networkFailures >= retryBudget ||
                        signal.aborted
                    ) {
                        throw err;
                    }
                    networkFailures++;
                    const delay = backoffDelayMs(networkFailures);
                    logStream(
                        "pi",
                        `${tag} attempt=${attempt} outcome=network-error retry_in_ms=${Math.round(delay)} err="${truncateForLog(err instanceof Error ? err.message : String(err))}"`,
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    attempt--; // transport failures have their own budget
                    continue;
                }
                await options?.onResponse?.(res as never, model);
                logStream(
                    "pi",
                    `${tag} attempt=${attempt} status=${res.status} ct=${res.headers.get("content-type") ?? "none"} ttfb_ms=${Date.now() - started}`,
                );

                if (res.ok) return res;

                // 401/403 -> re-auth once via OIDC (needs env credentials).
                if (
                    AUTH_RETRY_STATUSES.has(res.status) &&
                    (await tryReauth())
                ) {
                    attempt--; // this attempt doesn't count
                    continue;
                }

                // LiteLLM sometimes mislabels a transient Bedrock 503 as 400.
                if (res.status === 400 && attempt < retryBudget) {
                    const peek = await peekBody(res);
                    if (isRetryableErrorBody(peek)) {
                        log(
                            `[pi-stream] ${tag} 400 carries a transient upstream signature: "${truncateForLog(peek, 160)}"`,
                        );
                        continue;
                    }
                }

                const retryable =
                    res.status === RATE_LIMIT_STATUS ||
                    RETRY_STATUSES.has(res.status);
                if (!retryable || attempt >= retryBudget) break;
            }
            const detail = res
                ? `${res.status} ${truncateForLog(await peekBody(res), 500)}`
                : "no response";
            throw new Error(`OpenWebUI request failed: ${detail}`);
        };

        try {
            let startPushed = false;
            let res = await fetchOk();

            for (let streamAttempt = 0; ; streamAttempt++) {
                const diag = newStreamDiagnostics();
                const started = Date.now();
                let finishReason: StopReason;
                try {
                    if (!startPushed) {
                        stream.push({ type: "start", partial: output });
                        startPushed = true;
                    }
                    finishReason = await consumeResponse(
                        res,
                        stream,
                        output,
                        model,
                        diag,
                    );
                    logStream(
                        "pi",
                        `${tag} outcome=ok stream_attempt=${streamAttempt} ms=${Date.now() - started} stop=${finishReason} ${formatStreamDiagnostics(diag)}`,
                    );
                } catch (err) {
                    if (!(err instanceof StreamFailure)) throw err;
                    const emitted = !carriedNoContent(diag);
                    logStream(
                        "pi",
                        `${tag} outcome=${err.kind} stream_attempt=${streamAttempt} ms=${Date.now() - started} retryable=${err.retryable && !emitted} ${formatStreamDiagnostics(diag)}`,
                    );
                    if (emitted) throw err;
                    if (err.authSuspect && (await tryReauth())) {
                        res = await fetchOk();
                        continue;
                    }
                    if (
                        err.kind === "empty" &&
                        diag.finishReason === "length" &&
                        maxTokens < model.maxTokens
                    ) {
                        maxTokens = Math.min(maxTokens * 4, model.maxTokens);
                        body = buildPayload();
                        payload = JSON.stringify(body);
                        log(
                            `[pi-stream] ${tag} reasoning consumed the whole output budget; retrying with max_tokens=${maxTokens}`,
                        );
                        res = await fetchOk();
                        continue;
                    }
                    if (err.retryable && streamAttempt < retryBudget) {
                        const delay = backoffDelayMs(streamAttempt + 1);
                        log(
                            `[pi-stream] ${tag} stream retry #${streamAttempt + 1} in ${Math.round(delay)}ms after ${err.kind}`,
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        res = await fetchOk();
                        continue;
                    }
                    throw err;
                }

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
                return;
            }
        } catch (err) {
            const aborted =
                err instanceof Error &&
                (err.name === "AbortError" || err.message.includes("aborted"));
            output.stopReason = aborted ? "aborted" : "error";
            output.errorMessage =
                err instanceof Error ? err.message : String(err);
            if (!(err instanceof StreamFailure)) {
                log(
                    `[pi-stream] ${tag} outcome=${aborted ? "aborted" : "transport-error"} err="${truncateForLog(output.errorMessage)}"`,
                );
            }
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

/** Incremental writer that turns OpenAI chunks into pi content blocks/events. */
class ChunkWriter {
    private textIndex = -1;
    private thinkingIndex = -1;
    private readonly toolCalls = new Map<number, ToolCallAccumulator>();
    finishReason: StopReason | undefined;

    constructor(
        private readonly stream: AssistantMessageEventStream,
        private readonly output: AssistantMessage,
        private readonly diag: StreamDiagnostics,
    ) {}

    // The trace arrives before the answer, so its block is opened first and the
    // signature records which upstream field supplied it (round-trip fidelity).
    private ensureThinkingBlock(signature: string) {
        if (this.thinkingIndex === -1) {
            this.output.content.push({
                type: "thinking",
                thinking: "",
                thinkingSignature: signature,
            } as ThinkingContent);
            this.thinkingIndex = this.output.content.length - 1;
            this.stream.push({
                type: "thinking_start",
                contentIndex: this.thinkingIndex,
                partial: this.output,
            });
        }
    }

    private ensureTextBlock() {
        if (this.textIndex === -1) {
            this.output.content.push({ type: "text", text: "" } as TextContent);
            this.textIndex = this.output.content.length - 1;
            this.stream.push({
                type: "text_start",
                contentIndex: this.textIndex,
                partial: this.output,
            });
        }
    }

    private appendText(text: string) {
        this.ensureTextBlock();
        (this.output.content[this.textIndex] as TextContent).text += text;
        this.diag.textChars += text.length;
        this.stream.push({
            type: "text_delta",
            contentIndex: this.textIndex,
            delta: text,
            partial: this.output,
        });
    }

    write(chunk: OpenAIChunk) {
        const choice = chunk.choices?.[0];
        if (!choice) return;
        const delta = (choice.delta ?? {}) as OpenAIStreamDelta;

        for (const field of REASONING_FIELDS) {
            const reasoning = delta[field];
            if (typeof reasoning !== "string" || reasoning.length === 0)
                continue;
            this.ensureThinkingBlock(field);
            (
                this.output.content[this.thinkingIndex] as ThinkingContent
            ).thinking += reasoning;
            this.diag.thinkingChars += reasoning.length;
            this.stream.push({
                type: "thinking_delta",
                contentIndex: this.thinkingIndex,
                delta: reasoning,
                partial: this.output,
            });
            break;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
            this.appendText(delta.content);
        }
        // OpenAI-style refusals arrive out-of-band; surface them as the answer
        // text so the caller sees why the model declined instead of nothing.
        if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
            this.appendText(delta.refusal);
        }

        for (const tc of delta.tool_calls ?? []) {
            let acc = this.toolCalls.get(tc.index);
            if (!acc) {
                this.output.content.push({
                    type: "toolCall",
                    id: tc.id ?? `call_${tc.index}`,
                    name: tc.function?.name ?? "",
                    arguments: {},
                } as ToolCall);
                acc = {
                    contentIndex: this.output.content.length - 1,
                    id: tc.id ?? `call_${tc.index}`,
                    name: tc.function?.name ?? "",
                    argsBuffer: "",
                };
                this.toolCalls.set(tc.index, acc);
                this.diag.toolCalls++;
                this.stream.push({
                    type: "toolcall_start",
                    contentIndex: acc.contentIndex,
                    partial: this.output,
                });
            }
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) {
                acc.argsBuffer += tc.function.arguments;
                this.stream.push({
                    type: "toolcall_delta",
                    contentIndex: acc.contentIndex,
                    delta: tc.function.arguments,
                    partial: this.output,
                });
            }
        }

        if (choice.finish_reason) {
            this.finishReason = mapFinishReason(choice.finish_reason);
        }
    }

    /** Close every open block, emitting the *_end events. */
    finalize() {
        if (this.thinkingIndex !== -1) {
            const thinking = (
                this.output.content[this.thinkingIndex] as ThinkingContent
            ).thinking;
            this.stream.push({
                type: "thinking_end",
                contentIndex: this.thinkingIndex,
                content: thinking,
                partial: this.output,
            });
        }
        if (this.textIndex !== -1) {
            const content = (this.output.content[this.textIndex] as TextContent)
                .text;
            this.stream.push({
                type: "text_end",
                contentIndex: this.textIndex,
                content,
                partial: this.output,
            });
        }
        for (const acc of this.toolCalls.values()) {
            let args: Record<string, unknown> = {};
            try {
                args = acc.argsBuffer ? JSON.parse(acc.argsBuffer) : {};
            } catch {
                args = {};
            }
            const toolCall = this.output.content[acc.contentIndex] as ToolCall;
            toolCall.name = acc.name;
            toolCall.arguments = args;
            this.stream.push({
                type: "toolcall_end",
                contentIndex: acc.contentIndex,
                toolCall,
                partial: this.output,
            });
        }
    }

    get hasToolCalls() {
        return this.toolCalls.size > 0;
    }
}

function applyUsage(
    output: AssistantMessage,
    model: Model<Api>,
    usage: ReturnType<typeof parseUsageFromBuffer>,
) {
    if (!usage) return;
    output.usage.input = usage.input;
    output.usage.output = usage.output;
    output.usage.cacheRead = usage.cacheRead;
    output.usage.cacheWrite = usage.cacheWrite;
    output.usage.totalTokens =
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    output.usage.cost = calculateCost(model, output.usage);
}

/**
 * Consume an OK response according to its content type. Throws StreamFailure
 * for anything that must not be settled as a successful assistant message.
 */
async function consumeResponse(
    res: Response,
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    model: Model<Api>,
    diag: StreamDiagnostics,
): Promise<StopReason> {
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
        if (!res.body) {
            throw new StreamFailure(
                "OpenWebUI returned an event stream with no body",
                "truncated",
                true,
            );
        }
        return consumeSse(res.body, stream, output, model, diag);
    }
    if (contentType.includes("application/json")) {
        return consumeJson(await res.text(), stream, output, model, diag);
    }
    const sample = truncateForLog(await peekBody(res), 160);
    const looksLikeHtml = /<!doctype html|<html/i.test(sample);
    throw new StreamFailure(
        `OpenWebUI returned ${contentType || "an unknown content type"} instead of a completion${looksLikeHtml ? " (HTML page: wrong host or expired session?)" : ""}`,
        "unexpected-content-type",
        false,
        looksLikeHtml,
    );
}

/** A non-streamed JSON completion (proxy fell back from SSE) or a JSON error. */
function consumeJson(
    text: string,
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    model: Model<Api>,
    diag: StreamDiagnostics,
): StopReason {
    diag.bytes = text.length;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new StreamFailure(
            `OpenWebUI returned unparsable JSON: "${truncateForLog(text, 160)}"`,
            "json-error",
            false,
        );
    }
    if (parsed.error !== undefined || parsed.detail !== undefined) {
        const error = normalizeStreamError(parsed.error ?? parsed.detail);
        diag.errorFrames = 1;
        diag.firstError = error;
        throw new StreamFailure(
            `OpenWebUI returned an error: ${error.message}`,
            "json-error",
            isRetryableStreamError(error),
        );
    }
    const choices = parsed.choices as
        | Array<{
              message?: Record<string, unknown>;
              finish_reason?: string | null;
          }>
        | undefined;
    const message = choices?.[0]?.message ?? {};
    const writer = new ChunkWriter(stream, output, diag);
    diag.chunkFrames = 1;
    writer.write({
        choices: [
            {
                delta: message,
                finish_reason: choices?.[0]?.finish_reason ?? null,
            },
        ],
    });
    if (typeof choices?.[0]?.finish_reason === "string")
        diag.finishReason = choices[0].finish_reason;
    writer.finalize();
    if (parsed.usage) {
        diag.usageSeen = true;
        applyUsage(output, model, parseUsageFromBuffer(text));
    }
    return settle(writer, diag);
}

/** Final admission check shared by the SSE and JSON paths. */
function settle(writer: ChunkWriter, diag: StreamDiagnostics): StopReason {
    if (diag.firstError) {
        throw new StreamFailure(
            `OpenWebUI stream reported an error: ${diag.firstError.message}`,
            "error-frame",
            isRetryableStreamError(diag.firstError),
        );
    }
    if (writer.finishReason === "error") {
        throw new StreamFailure(
            `OpenWebUI stream ended with finish_reason=${diag.finishReason}`,
            "content-filter",
            false,
        );
    }
    if (!reachedTerminalFrame(diag)) {
        throw new StreamFailure(
            carriedNoContent(diag)
                ? "OpenWebUI stream ended without a terminal frame and without content"
                : `OpenWebUI stream was cut off after ${diag.textChars} text chars (no finish_reason or [DONE])`,
            "truncated",
            carriedNoContent(diag),
        );
    }
    if (carriedNoContent(diag)) {
        throw new StreamFailure(
            `OpenWebUI returned an empty completion (finish=${diag.finishReason ?? "none"}, done=${diag.sawDone}, usage=${diag.usageSeen})`,
            "empty",
            true,
        );
    }
    let finishReason = writer.finishReason ?? "stop";
    if (writer.hasToolCalls && finishReason === "stop")
        finishReason = "toolUse";
    return finishReason;
}

/**
 * Parse an OpenAI-compatible SSE stream, emitting pi text/tool events onto
 * `stream` and mutating `output` in place. Returns the final stop reason or
 * throws StreamFailure when the stream must not be treated as a success.
 */
async function consumeSse(
    bodyStream: ReadableStream<Uint8Array>,
    stream: AssistantMessageEventStream,
    output: AssistantMessage,
    model: Model<Api>,
    diag: StreamDiagnostics,
): Promise<StopReason> {
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usageBuffer = "";
    let raw = "";
    const writer = new ChunkWriter(stream, output, diag);

    const handleLine = (line: string) => {
        diag.lines++;
        if (!line.startsWith("data:")) return;
        const frame = classifySseFrame(line.slice(5));
        recordFrame(diag, frame);
        if (frame.kind === "chunk") writer.write(frame.chunk);
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            diag.bytes += value.byteLength;
            buffer += text;
            usageBuffer += text;
            if (usageBuffer.length > 8192)
                usageBuffer = usageBuffer.slice(-8192);
            raw += text;

            let nl: number;
            // biome-ignore lint/suspicious/noAssignInExpressions: SSE line split
            while ((nl = buffer.indexOf("\n")) !== -1) {
                handleLine(buffer.slice(0, nl).trim());
                buffer = buffer.slice(nl + 1);
                // The first error frame is terminal for LiteLLM; stop reading
                // so a wedged upstream cannot hold the connection open.
                if (diag.firstError) break;
            }
            if (diag.firstError) break;
        }
        if (!diag.firstError && buffer.trim().length > 0)
            handleLine(buffer.trim());
    } finally {
        reader.releaseLock();
        if (diag.firstError) {
            try {
                await bodyStream.cancel();
            } catch {}
        }
    }

    writer.finalize();
    applyUsage(output, model, parseUsageFromBuffer(usageBuffer));

    try {
        return settle(writer, diag);
    } catch (err) {
        logDebugArtifact(
            "pi-stream-failures",
            `model=${model.id} ${formatStreamDiagnostics(diag)}`,
            raw,
        );
        throw err;
    }
}
