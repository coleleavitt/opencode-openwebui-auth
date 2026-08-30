import type { JwtClaims } from "../types";

export function parseJwtClaims(token: string): JwtClaims | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        const parsed = JSON.parse(json) as JwtClaims;
        if (typeof parsed.id !== "string" || typeof parsed.exp !== "number") {
            return undefined;
        }
        return parsed;
    } catch {
        return undefined;
    }
}

export function isTokenExpired(token: string, skewMs = 60_000): boolean {
    const claims = parseJwtClaims(token);
    if (!claims) return true;
    return Date.now() + skewMs >= claims.exp * 1000;
}
