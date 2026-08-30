# openwebui-auth

Authenticate AI coding agents to an [OpenWebUI](https://github.com/open-webui/open-webui)
instance (e.g. a university / company LLM gateway) using your existing browser session,
and route model traffic through it. Auth is an automated **Shibboleth + Duo OIDC** login,
so you never hand-paste JWTs.

Monorepo (bun workspaces):

| Package | Name | What it is |
| --- | --- | --- |
| `packages/core` | `@openwebui-auth/core` | Shared OIDC login, account store, pricing, API client. Host-agnostic. |
| `packages/opencode` | `opencode-openwebui-auth` | opencode plugin: dynamic model discovery + auth-aware fetch shim. |
| `packages/pi` | `@openwebui-auth/pi` | pi extension: OpenWebUI as an OpenAI-compatible provider. |

## Develop
```bash
bun install
bun run build       # core -> opencode -> pi
bun run typecheck   # all packages
bun run test        # core + opencode suites
```

See `STRUCTURE.md` for the layout and `packages/*/README.md` for per-package docs.
