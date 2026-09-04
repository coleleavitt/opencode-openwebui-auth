// Shared SSE frame classification and stream diagnostics for OWUI/LiteLLM
// chat completions. Used by the pi streamSimple (to decide success/retry/error)
// and by the opencode fetch shim (to log what passed through), so both adapters
// describe a stream the same way.
//
// LiteLLM's proxy never uses an HTTP error status for a failure that happens
// after streaming started: it emits `data: {"error": {...}}` and stops WITHOUT
// a trailing `data: [DONE]`. Open WebUI's own frontend treats that frame as a
// terminal error. A consumer that only reads `choices[].delta` sees an empty,
// nominally successful stream instead.

import {
    isRetryableErrorBody,
    RATE_LIMIT_STATUS,
    RETRY_STATUSES,
} from "./retry-policy";

export interface StreamErrorInfo {
    message: string;
    type?: string;
    code?: number;
}

export interface OpenAIChunkChoice {
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
}

export interface OpenAIChunk {
    choices?: OpenAIChunkChoice[];
    usage?: Record<string, unknown>;
    error?: unknown;
    selected_model_id?: unknown;
    sources?: unknown;
}

export type SseFrame =
    | { kind: "done" }
    | { kind: "error"; error: StreamErrorInfo }
    | { kind: "chunk"; chunk: OpenAIChunk }
    | { kind: "meta"; chunk: OpenAIChunk }
    | { kind: "empty" }
    | { kind: "unparsable"; sample: string };

/** Bound any provider-supplied text before it reaches a log line. */
export function truncateForLog(text: string, max = 300): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Normalize the many shapes an `error` field arrives in:
 *  - LiteLLM proxy: `{message, type, param, code}` (code may be a string)
 *  - Open WebUI event path: `{content: "..."}` / `{detail: "..."}`
 *  - guardrails / ad-hoc: a bare string
 */
export function normalizeStreamError(raw: unknown): StreamErrorInfo {
    if (typeof raw === "string") return { message: raw };
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const message =
            firstString(obj.message, obj.content, obj.detail, obj.error) ??
            JSON.stringify(obj);
        const code = Number(obj.code ?? obj.status_code ?? obj.status);
        return {
            message,
            type: typeof obj.type === "string" ? obj.type : undefined,
            code: Number.isFinite(code) ? code : undefined,
        };
    }
    return { message: String(raw) };
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
}

/** True when a stream-level error is transient (worth one bounded retry). */
export function isRetryableStreamError(error: StreamErrorInfo): boolean {
    if (error.code !== undefined) {
        if (error.code === RATE_LIMIT_STATUS || RETRY_STATUSES.has(error.code))
            return true;
        if (error.code >= 400 && error.code < 500)
            return isRetryableErrorBody(error.message);
    }
    return isRetryableErrorBody(error.message);
}

/** Classify the payload of one `data:` SSE line. */
export function classifySseFrame(data: string): SseFrame {
    const trimmed = data.trim();
    if (trimmed === "[DONE]") return { kind: "done" };
    if (trimmed === "" || trimmed === "{}") return { kind: "empty" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { kind: "unparsable", sample: truncateForLog(trimmed, 120) };
    }
    if (!parsed || typeof parsed !== "object") {
        return { kind: "unparsable", sample: truncateForLog(trimmed, 120) };
    }
    const chunk = parsed as OpenAIChunk;
    if (chunk.error !== undefined && chunk.error !== null) {
        return { kind: "error", error: normalizeStreamError(chunk.error) };
    }
    if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
        return { kind: "chunk", chunk };
    }
    if (chunk.usage && typeof chunk.usage === "object") {
        return { kind: "chunk", chunk };
    }
    return { kind: "meta", chunk };
}

/** Counters describing what a completion stream actually carried. */
export interface StreamDiagnostics {
    bytes: number;
    lines: number;
    dataFrames: number;
    chunkFrames: number;
    metaFrames: number;
    emptyFrames: number;
    unparsableFrames: number;
    errorFrames: number;
    sawDone: boolean;
    finishReason?: string;
    textChars: number;
    thinkingChars: number;
    toolCalls: number;
    usageSeen: boolean;
    firstError?: StreamErrorInfo;
    unparsableSample?: string;
}

export function newStreamDiagnostics(): StreamDiagnostics {
    return {
        bytes: 0,
        lines: 0,
        dataFrames: 0,
        chunkFrames: 0,
        metaFrames: 0,
        emptyFrames: 0,
        unparsableFrames: 0,
        errorFrames: 0,
        sawDone: false,
        textChars: 0,
        thinkingChars: 0,
        toolCalls: 0,
        usageSeen: false,
    };
}

/** Record a classified frame into the counters (content counters are the caller's). */
export function recordFrame(diag: StreamDiagnostics, frame: SseFrame): void {
    diag.dataFrames++;
    switch (frame.kind) {
        case "done":
            diag.sawDone = true;
            break;
        case "error":
            diag.errorFrames++;
            if (!diag.firstError) diag.firstError = frame.error;
            break;
        case "chunk": {
            diag.chunkFrames++;
            const reason = frame.chunk.choices?.[0]?.finish_reason;
            if (typeof reason === "string" && reason.length > 0)
                diag.finishReason = reason;
            if (frame.chunk.usage) diag.usageSeen = true;
            break;
        }
        case "meta":
            diag.metaFrames++;
            break;
        case "empty":
            diag.emptyFrames++;
            break;
        case "unparsable":
            diag.unparsableFrames++;
            if (!diag.unparsableSample) diag.unparsableSample = frame.sample;
            break;
    }
}

/** A stream that reached a provider-declared end: `[DONE]` or a finish_reason. */
export function reachedTerminalFrame(diag: StreamDiagnostics): boolean {
    return diag.sawDone || diag.finishReason !== undefined;
}

/** A stream that produced nothing a consumer could act on. */
export function carriedNoContent(diag: StreamDiagnostics): boolean {
    return (
        diag.textChars === 0 && diag.thinkingChars === 0 && diag.toolCalls === 0
    );
}

/** Compact `key=value` rendering for a single log line. Never includes bodies. */
export function formatStreamDiagnostics(diag: StreamDiagnostics): string {
    const parts = [
        `bytes=${diag.bytes}`,
        `frames=${diag.dataFrames}`,
        `chunks=${diag.chunkFrames}`,
        `meta=${diag.metaFrames}`,
        `empty=${diag.emptyFrames}`,
        `unparsable=${diag.unparsableFrames}`,
        `errors=${diag.errorFrames}`,
        `done=${diag.sawDone}`,
        `finish=${diag.finishReason ?? "none"}`,
        `text=${diag.textChars}`,
        `think=${diag.thinkingChars}`,
        `tools=${diag.toolCalls}`,
        `usage=${diag.usageSeen}`,
    ];
    if (diag.firstError) {
        parts.push(
            `err_code=${diag.firstError.code ?? "none"}`,
            `err_type=${diag.firstError.type ?? "none"}`,
            `err_msg="${truncateForLog(diag.firstError.message)}"`,
        );
    }
    if (diag.unparsableSample) {
        parts.push(`unparsable_sample="${diag.unparsableSample}"`);
    }
    return parts.join(" ");
}

/**
 * Feed raw SSE text through the classifier purely for diagnostics (used by
 * pass-through adapters that do not parse the stream themselves). Handles
 * partial lines across calls via the returned carry.
 */
export function scanSseText(
    diag: StreamDiagnostics,
    text: string,
    carry: string,
    onChunk?: (chunk: OpenAIChunk) => void,
): string {
    let buffer = carry + text;
    let nl: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: SSE line split
    while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        diag.lines++;
        if (!line.startsWith("data:")) continue;
        const frame = classifySseFrame(line.slice(5));
        recordFrame(diag, frame);
        if (frame.kind === "chunk" && onChunk) onChunk(frame.chunk);
    }
    return buffer;
}

/** Count delta content into the diagnostics (text / reasoning / tool calls). */
export function recordChunkContent(
    diag: StreamDiagnostics,
    chunk: OpenAIChunk,
): void {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string")
        diag.textChars += delta.content.length;
    if (typeof delta.refusal === "string")
        diag.textChars += delta.refusal.length;
    for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
        const value = delta[field];
        if (typeof value === "string") {
            diag.thinkingChars += value.length;
            break;
        }
    }
    const toolCalls = delta.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
            const id = (call as { id?: unknown }).id;
            if (typeof id === "string" && id.length > 0) diag.toolCalls++;
        }
    }
}
