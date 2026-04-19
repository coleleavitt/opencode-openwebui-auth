export interface PerModelUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    requestCount: number;
    costUsd: number;
    firstSeen: string;
    lastSeen: string;
}

export interface OpenWebUIAccount {
    name: string;
    baseUrl: string;
    token: string;
    expiresAt?: number;
    createdAt: number;
    updatedAt: number;
    disabled?: boolean;

    dailyUsage?: {
        date: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        requestCount: number;
    };

    totalUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        requestCount: number;
        costUsd: number;
        firstSeen: string;
        byModel?: Record<string, PerModelUsage>;
    };
}

export interface OpenWebUIStore {
    version: 1;
    current?: string;
    accounts: Record<string, OpenWebUIAccount>;
}

export interface OpenWebUIModelInfo {
    id: string;
    name?: string;
    object?: string;
    created?: number;
    owned_by?: string;
    connection_type?: "external" | "internal" | string;
    urlIdx?: number;
    info?: {
        id?: string;
        user_id?: string;
        base_model_id?: string | null;
        name?: string;
        meta?: {
            description?: string | null;
            capabilities?: {
                file_context?: boolean;
                vision?: boolean;
                file_upload?: boolean;
                web_search?: boolean;
                image_generation?: boolean;
                code_interpreter?: boolean;
                citations?: boolean;
                status_updates?: boolean;
                usage?: boolean;
                builtin_tools?: boolean;
                [key: string]: boolean | undefined;
            };
            suggestion_prompts?: string[] | null;
            tags?: { name: string }[];
            defaultFeatureIds?: string[];
        };
        is_active?: boolean;
        access_control?: unknown;
        updated_at?: number;
        created_at?: number;
    };
    actions?: unknown[];
    filters?: unknown[];
    tags?: { name: string }[];
    arena?: boolean;
    pipeline?: { type?: string };
}

export interface OpenWebUIModelsResponse {
    data: OpenWebUIModelInfo[];
}

export interface OpenWebUIConfigResponse {
    status: boolean;
    name: string;
    version: string;
    features?: Record<string, boolean>;
}

export interface JwtClaims {
    id: string;
    exp: number;
    jti?: string;
}
