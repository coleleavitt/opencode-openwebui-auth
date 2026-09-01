// Shared retry policy for OWUI/LiteLLM+Bedrock traffic. Used by every adapter so
// the opencode fetch shim and the pi streamSimple retry identically.

/** 5xx and Anthropic "overloaded" (529) are transient — retry with backoff. */
export const RETRY_STATUSES = new Set([502, 503, 504, 529]);

/** 429 = rate limited. The instance runs an active rate_limit_inlet_filter, and
 *  upstream (Anthropic/Bedrock) also emit 429 with a Retry-After hint. Handled
 *  separately so we can honor Retry-After instead of the generic backoff. */
export const RATE_LIMIT_STATUS = 429;

/** 401/403 — token likely expired; trigger a re-auth before retrying. */
export const AUTH_RETRY_STATUSES = new Set([401, 403]);

export const MAX_RETRIES = 2;
export const RETRY_BASE_MS = 1500;

/** Cap the honored Retry-After so a hostile/buggy header can't stall a request. */
export const MAX_RETRY_AFTER_MS = 30_000;

// LiteLLM v1.81–1.84+ misclassifies Bedrock's serviceUnavailableException as
// HTTP 400 (BadRequestError) instead of 503. The Bedrock event-stream decoder
// uses the HTTP status from the binary event frame (always 400 for streaming
// errors) rather than mapping :exception-type to the correct semantic code.
// Detect these by inspecting the response body for known transient signatures
// and retry them as if they were 503s.
export const RETRYABLE_BODY_PATTERNS = [
    "serviceUnavailableException",
    "Bedrock is unable to process your request",
    "MidStreamFallbackError",
    "modelTimeoutException",
    "modelStreamErrorException",
    // OWUI's own proxy layer failing to reach LiteLLM, also surfaced as a 400.
    "Open WebUI: Server Connection Error",
];

/** True when a 400 body is really a transient Bedrock error LiteLLM mislabeled. */
export function isRetryableErrorBody(text: string): boolean {
    return RETRYABLE_BODY_PATTERNS.some((p) => text.includes(p));
}

/**
 * Parse an HTTP Retry-After header into milliseconds. Supports both the
 * delta-seconds form ("120") and the HTTP-date form ("Wed, 21 Oct 2026 …").
 * Returns undefined if absent/unparseable.
 */
export function parseRetryAfterMs(res: {
    headers: { get(name: string): string | null };
}): number | undefined {
    const raw = res.headers.get("retry-after");
    if (!raw) return undefined;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const when = Date.parse(raw);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
    return undefined;
}

/** Jittered exponential backoff for retry attempt N (1-based). */
export function backoffDelayMs(attempt: number): number {
    return RETRY_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5);
}

/**
 * Decide the wait before the next attempt given a failed response, or undefined
 * if the status is not retryable. A 429 with Retry-After returns that delay
 * (clamped); other retryable statuses return jittered backoff.
 */
export function nextRetryDelayMs(
    res: { status: number; headers: { get(name: string): string | null } },
    attempt: number,
    xShouldRetry?: string | null,
): number | undefined {
    if (res.status === RATE_LIMIT_STATUS) {
        const retryAfter = parseRetryAfterMs(res);
        return retryAfter !== undefined
            ? Math.min(retryAfter, MAX_RETRY_AFTER_MS)
            : backoffDelayMs(attempt);
    }
    const shouldRetry =
        xShouldRetry === "true" ||
        (xShouldRetry !== "false" && RETRY_STATUSES.has(res.status));
    return shouldRetry ? backoffDelayMs(attempt) : undefined;
}

/** Token-refresh skew: renew this long BEFORE expiry so long streams started
 *  near the boundary don't die mid-flight. Override with OWUI_REFRESH_SKEW_MS. */
export const DEFAULT_REFRESH_SKEW_MS = 10 * 60_000;

export function refreshSkewMs(): number {
    const raw = Number(process.env.OWUI_REFRESH_SKEW_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REFRESH_SKEW_MS;
}
