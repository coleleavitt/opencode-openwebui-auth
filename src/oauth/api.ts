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
