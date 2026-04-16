import type { OpenWebUIConfigResponse, OpenWebUIModelsResponse } from "../types";

function stripTrailingSlash(s: string): string {
    return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function normalizeBaseUrl(url: string): string {
    const trimmed = stripTrailingSlash(url.trim());
    if (!/^https?:\/\//i.test(trimmed)) {
        throw new Error(`Base URL must start with http:// or https:// (got ${trimmed})`);
    }
    return trimmed;
}

export async function fetchInstanceConfig(baseUrl: string): Promise<OpenWebUIConfigResponse> {
    const res = await fetch(`${baseUrl}/api/config`, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET /api/config failed: ${res.status}`);
    return (await res.json()) as OpenWebUIConfigResponse;
}

export async function verifyToken(baseUrl: string, token: string): Promise<{ id: string; email: string; role: string; name: string }> {
    const res = await fetch(`${baseUrl}/api/v1/auths/`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Token rejected (${res.status}): ${body.slice(0, 200)}`);
    }
    return (await res.json()) as { id: string; email: string; role: string; name: string };
}

export async function listModels(baseUrl: string, token: string): Promise<OpenWebUIModelsResponse> {
    const res = await fetch(`${baseUrl}/api/models`, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
    });
    if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
    return (await res.json()) as OpenWebUIModelsResponse;
}

/**
 * Build an opencode `Model` object from an OWUI `/api/models` entry.
 * Schema verified against opencode/packages/opencode/src/provider/provider.ts:777-846.
 *
 * Defaults are conservative (e.g. context=200K matches Claude/GPT-4 era).
 * Cost is always {0,0,0,0} because the OWUI instance owner pays, not the user.
 */
export function buildOpencodeModel(
    providerID: string,
    baseUrl: string,
    npm: string,
    raw: import("../types").OpenWebUIModelInfo,
): Record<string, unknown> {
    const caps = raw.info?.meta?.capabilities ?? {};
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
        limit: { context: 200000, output: 8192 },
        capabilities: {
            temperature: true,
            reasoning: false,
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
        variants: {},
    };
}
