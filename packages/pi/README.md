# @openwebui-auth/pi

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that
registers an OpenWebUI instance as an **OpenAI-compatible provider**, authenticated
through University-of-Arizona Shibboleth + Duo OIDC (via `@openwebui-auth/core`).

- `/login openwebui` runs the automated OIDC flow (or reuses env credentials).
- The OWUI JWT is used as the bearer key; "refresh" re-runs OIDC since OWUI issues
  no refresh token.
- Models are discovered live from `/api/models`.

## Install
```jsonc
// pi extension config
{ "extensions": ["@openwebui-auth/pi"] }
```

## Env
- `OWUI_BASE_URL` (default `https://chat.ai2s.org`)
- `OWUI_USERNAME`, `OWUI_PASSWORD`, `OWUI_DUO_PASSCODE` — for unattended login/refresh.
