import { afterEach, expect, test } from "bun:test";

import {
    configureTraceApiForTests,
    recordOpenWebUIStreamDiagnostics,
} from "./pi-trace";

afterEach(() => configureTraceApiForTests(undefined));

test("records bounded stream diagnostics on the active host span", () => {
    const recorded: Record<string, unknown>[] = [];
    configureTraceApiForTests({
        currentSpan: () => ({
            setAttributes: (attributes) => recorded.push(attributes),
        }),
    });

    recordOpenWebUIStreamDiagnostics("req-1", 2, "empty", {
        bytes: 48,
        lines: 6,
        dataFrames: 3,
        chunkFrames: 2,
        metaFrames: 0,
        emptyFrames: 0,
        unparsableFrames: 0,
        errorFrames: 0,
        sawDone: true,
        finishReason: "stop",
        textChars: 0,
        thinkingChars: 0,
        toolCalls: 0,
        usageSeen: true,
    });

    expect(recorded).toEqual([
        expect.objectContaining({
            "owui.request_id": "req-1",
            "owui.stream_attempt": 2,
            "owui.stream_outcome": "empty",
            "owui.bytes": 48,
            "owui.frames": 3,
            "owui.chunk_frames": 2,
            "owui.saw_done": true,
            "owui.finish_reason": "stop",
            "owui.usage_seen": true,
        }),
    ]);
});

test("degrades when the host has no tracing API", () => {
    configureTraceApiForTests({ currentSpan: () => undefined });
    expect(() =>
        recordOpenWebUIStreamDiagnostics("req-2", 0, "empty", {
            bytes: 0,
            lines: 0,
            dataFrames: 0,
            chunkFrames: 0,
            metaFrames: 0,
            emptyFrames: 0,
            unparsableFrames: 0,
            errorFrames: 0,
            sawDone: true,
            textChars: 0,
            thinkingChars: 0,
            toolCalls: 0,
            usageSeen: false,
        }),
    ).not.toThrow();
});
