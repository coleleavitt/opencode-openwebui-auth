# @openwebui-auth/pi

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that
registers an OpenWebUI instance as an **OpenAI-compatible provider**, authenticated
through University-of-Arizona Shibboleth + Duo OIDC (via `@openwebui-auth/core`).

- `/login openwebui` runs the automated OIDC flow (or reuses env credentials).
- The OWUI JWT is used as the bearer key; "refresh" re-runs OIDC since OWUI issues
  no refresh token.
- Models are discovered live from `/api/models`.
- A custom `streamSimple` shapes requests for OWUI → LiteLLM → Bedrock (blank-text
  sanitizing, tool-field scrubbing), retries 429/5xx and LiteLLM-mislabeled 400s,
  re-authenticates on 401/403, parses the OpenAI SSE stream into pi events, and
  accounts token usage — the same behavior as the opencode fetch shim, shared via
  `@openwebui-auth/core`.

## Install
```jsonc
// pi extension config
{ "extensions": ["@openwebui-auth/pi"] }
```

## Env
- `OWUI_BASE_URL` (default `https://chat.ai2s.org`)
- `OWUI_USERNAME`, `OWUI_PASSWORD`, `OWUI_DUO_PASSCODE` — for unattended login/refresh.
