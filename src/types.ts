export interface OpenWebUIAccount {
    name: string;
    baseUrl: string;
    token: string;
    expiresAt?: number;
    createdAt: number;
    updatedAt: number;
    disabled?: boolean;
}

export interface OpenWebUIStore {
    version: 1;
    current?: string;
    accounts: Record<string, OpenWebUIAccount>;
}

export interface OpenWebUIModelInfo {
    id: string;
    name?: string;
    info?: {
        meta?: {
            capabilities?: Record<string, boolean>;
        };
    };
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
