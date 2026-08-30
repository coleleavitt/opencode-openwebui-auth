# @openwebui-auth/core

Shared, host-agnostic building blocks for authenticating to an
[OpenWebUI](https://github.com/open-webui/open-webui) instance and talking to its API:

- **OIDC login** — automated Shibboleth + Duo Universal Prompt v4 flow (`oidcLogin`).
- **Account storage** — JSON account store with token lifetime + usage tracking (`Storage`).
- **Pricing** — per-model cost inference and usage accounting.
- **API client** — `fetchInstanceConfig`, `verifyToken`, `listModels`, model-limit and
  Claude reasoning-variant helpers (`inferModelLimits`, `buildClaudeVariants`).
- **JWT** — `parseJwtClaims`, `isTokenExpired`.

Consumed by the `opencode` plugin and the `pi` extension adapters; contains no
host-framework code.
