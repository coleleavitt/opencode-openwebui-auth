import * as PiAI from "@earendil-works/pi-ai";
import type { StreamDiagnostics } from "@openwebui-auth/core";

interface TraceSpan {
    setAttributes(
        attributes: Record<string, string | number | boolean | undefined>,
    ): void;
}

interface TraceApi {
    currentSpan(): TraceSpan | undefined;
}

let testApi: TraceApi | undefined;

function traceApi(): TraceApi | undefined {
    if (testApi) return testApi;
    const candidate = PiAI as typeof PiAI & Partial<TraceApi>;
    return typeof candidate.currentSpan === "function"
        ? { currentSpan: () => candidate.currentSpan?.() }
        : undefined;
}

/** Attach bounded OWUI stream counters to the host's active llm.request span. */
export function recordOpenWebUIStreamDiagnostics(
    requestId: string,
    attempt: number,
    outcome: string,
    diagnostics: StreamDiagnostics,
): void {
    try {
        traceApi()
            ?.currentSpan()
            ?.setAttributes({
                "owui.request_id": requestId,
                "owui.stream_attempt": attempt,
                "owui.stream_outcome": outcome,
                "owui.bytes": diagnostics.bytes,
                "owui.lines": diagnostics.lines,
                "owui.frames": diagnostics.dataFrames,
                "owui.chunk_frames": diagnostics.chunkFrames,
                "owui.meta_frames": diagnostics.metaFrames,
                "owui.empty_frames": diagnostics.emptyFrames,
                "owui.unparsable_frames": diagnostics.unparsableFrames,
                "owui.error_frames": diagnostics.errorFrames,
                "owui.saw_done": diagnostics.sawDone,
                "owui.finish_reason": diagnostics.finishReason ?? "none",
                "owui.text_chars": diagnostics.textChars,
                "owui.thinking_chars": diagnostics.thinkingChars,
                "owui.tool_calls": diagnostics.toolCalls,
                "owui.usage_seen": diagnostics.usageSeen,
                "owui.first_error_code": diagnostics.firstError?.code,
                "owui.first_error_type": diagnostics.firstError?.type,
            });
    } catch {
        // Diagnostics must never affect the provider stream.
    }
}

export function configureTraceApiForTests(api: TraceApi | undefined): void {
    testApi = api;
}
