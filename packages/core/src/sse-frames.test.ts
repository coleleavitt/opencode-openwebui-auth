import { expect, test } from "bun:test";

import {
    carriedNoContent,
    classifySseFrame,
    formatStreamDiagnostics,
    isRetryableStreamError,
    newStreamDiagnostics,
    normalizeStreamError,
    reachedTerminalFrame,
    recordChunkContent,
    recordFrame,
    scanSseText,
} from "./sse-frames";

test("classifies the LiteLLM proxy error frame as a terminal error", () => {
    const frame = classifySseFrame(
        ' {"error": {"message": "litellm.ServiceUnavailableError: BedrockException - serviceUnavailableException", "type": "None", "param": "None", "code": "503"}}',
    );
    expect(frame.kind).toBe("error");
    if (frame.kind !== "error") throw new Error("unreachable");
    expect(frame.error.code).toBe(503);
    expect(frame.error.message).toContain("serviceUnavailableException");
    expect(isRetryableStreamError(frame.error)).toBe(true);
});

test("classifies [DONE], {} skip-mode frames, meta frames and garbage", () => {
    expect(classifySseFrame(" [DONE]").kind).toBe("done");
    expect(classifySseFrame(" {}").kind).toBe("empty");
    expect(classifySseFrame("").kind).toBe("empty");
    expect(classifySseFrame(' {"selected_model_id":"x"}').kind).toBe("meta");
    expect(classifySseFrame(" not json at all").kind).toBe("unparsable");
    expect(
        classifySseFrame(' {"choices":[{"delta":{"content":"a"}}]}').kind,
    ).toBe("chunk");
    expect(
        classifySseFrame(' {"choices":[],"usage":{"completion_tokens":1}}')
            .kind,
    ).toBe("chunk");
});

test("normalizes the error shapes each layer emits", () => {
    expect(normalizeStreamError("plain").message).toBe("plain");
    expect(normalizeStreamError({ content: "owui event" }).message).toBe(
        "owui event",
    );
    expect(normalizeStreamError({ detail: "guardrail" }).message).toBe(
        "guardrail",
    );
    const litellm = normalizeStreamError({
        message: "boom",
        type: "internal_server_error",
        code: 500,
    });
    expect(litellm).toEqual({
        message: "boom",
        type: "internal_server_error",
        code: 500,
    });
    expect(
        isRetryableStreamError({ message: "Invalid tool schema", code: 400 }),
    ).toBe(false);
    expect(
        isRetryableStreamError({
            message: "Bedrock is unable to process your request",
            code: 400,
        }),
    ).toBe(true);
    expect(isRetryableStreamError({ message: "rate", code: 429 })).toBe(true);
    // Older LiteLLM labels every mid-stream Bedrock event 400; the modeled
    // exception name in the message is then the only retry signal.
    expect(
        isRetryableStreamError({
            message: 'throttlingException {"message":"Too many requests"}',
            code: 400,
        }),
    ).toBe(true);
    expect(
        isRetryableStreamError({
            message: 'validationException {"message":"bad input"}',
            code: 400,
        }),
    ).toBe(false);
    expect(isRetryableStreamError({ message: "stream broke", code: 424 })).toBe(
        true,
    );
});

test("diagnostics distinguish an error-only stream from a real completion", () => {
    const failed = newStreamDiagnostics();
    let carry = scanSseText(
        failed,
        'data: {"error": {"message": "upstream died", "code": 500}}\n\n',
        "",
    );
    expect(carry).toBe("");
    expect(failed.errorFrames).toBe(1);
    expect(reachedTerminalFrame(failed)).toBe(false);
    expect(carriedNoContent(failed)).toBe(true);
    expect(formatStreamDiagnostics(failed)).toContain(
        'err_msg="upstream died"',
    );

    const ok = newStreamDiagnostics();
    carry = scanSseText(
        ok,
        'data: {"choices":[{"delta":{"content":"OK","role":"assistant"}}]}\ndata: {"choices":[{"finish_reason":"stop","delta":{}}]}\ndata: {"choices":[{"delta":{}}],"usage":{"completion_tokens":5,"prompt_tokens":11}}\ndata: [DO',
        "",
        (chunk) => recordChunkContent(ok, chunk),
    );
    expect(carry).toBe("data: [DO");
    scanSseText(ok, "NE]\n", carry);
    expect(ok.sawDone).toBe(true);
    expect(ok.finishReason).toBe("stop");
    expect(ok.usageSeen).toBe(true);
    expect(ok.textChars).toBe(2);
    expect(reachedTerminalFrame(ok)).toBe(true);
    expect(carriedNoContent(ok)).toBe(false);
});

test("counts tool calls once per call id and reasoning in any spelling", () => {
    const diag = newStreamDiagnostics();
    for (const line of [
        '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{"}}]}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}',
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ]) {
        const frame = classifySseFrame(line);
        recordFrame(diag, frame);
        if (frame.kind === "chunk") recordChunkContent(diag, frame.chunk);
    }
    expect(diag.toolCalls).toBe(1);
    expect(diag.thinkingChars).toBe(5);
    expect(diag.finishReason).toBe("tool_calls");
});
