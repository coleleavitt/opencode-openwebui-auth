# opencode-openwebui-auth

opencode plugin that routes `chat/completions` traffic through an
[OpenWebUI](https://github.com/open-webui/open-webui) instance, using your
existing user JWT instead of a direct provider API key.

Useful when the models (Anthropic, Bedrock, OpenAI, etc.) are not directly
reachable from your machine but are exposed through an OWUI deployment you
already have a browser session for — e.g. a university or company LLM gateway.

Includes an **automated OIDC login** for OWUI instances fronted by Shibboleth
+ Duo Universal Prompt v4 (frameless), so you don't have to hand-paste JWTs
every time your token expires.

## Install

```bash
bun install
bun run build
```

## Configure opencode

Register OpenWebUI as a provider in `~/.config/opencode/opencode.json` so opencode
knows how to talk to it (OWUI exposes an OpenAI-compatible `/api/chat/completions`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/you/WebstormProjects/opencode-openwebui-auth/dist/bundle.js"
  ],
  "provider": {
    "openwebui": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenWebUI",
      "options": {
        "baseURL": "https://chat.ai2s.org/api"
      },
      "models": {
        "bedrock-claude-4-6-opus":       { "name": "Claude Opus 4.6" },
        "bedrock-claude-4-5-haiku":      { "name": "Claude Haiku 4.5" },
        "google.gemma-3-12b-it":         { "name": "Gemma 3 12B IT" },
        "openai.gpt-oss-120b-1:0":       { "name": "GPT-OSS 120B" },
        "meta.llama4-maverick-17b-instruct-v1:0": { "name": "Llama 4 Maverick 17B" },
        "bedrock-nova-pro-v1":           { "name": "Amazon Nova Pro" }
      }
    }
  }
}
```

## Authenticate

### Option 1 — Automated OIDC login (Shibboleth + Duo 2FA)

For OWUI instances that sit behind Shibboleth OIDC with Duo Universal Prompt v4
(e.g. `chat.ai2s.org` → `shibboleth.arizona.edu` → `api-*.duosecurity.com`):

```bash
# Duo Push (approve on your phone when it arrives)
OWUI_USERNAME=netid OWUI_PASSWORD='your-password' \
    bun src/cli.ts login

# Or with a passcode from Duo Mobile (no push needed)
OWUI_USERNAME=netid OWUI_PASSWORD='your-password' OWUI_DUO_PASSCODE=123456 \
    bun src/cli.ts login
```

This runs the full 6-step flow:

1. `GET /oauth/oidc/login` → redirects to Shibboleth
2. POST localStorage probe (e1s1) → POST credentials (e1s2)
3. Navigate Spring Web Flow to Duo 2FA handoff
4. Duo v4 frameless: two `plugin_form` POSTs with the healthcheck cycle,
   then factor submission + status polling + OIDC exit
5. Shibboleth post-Duo localStorage save (e1s4)
6. `/oauth/oidc/callback` → extract JWT from the `token` cookie → persist

On success it writes the JWT to `~/.config/opencode/openwebui-accounts.json` and
wires up `~/.local/share/opencode/auth.json` so opencode picks the plugin up.

### Option 2 — Manual JWT paste (any OWUI)

If your OWUI instance doesn't use Shibboleth, or you want to bypass the flow:

1. Open your OpenWebUI instance in a browser and sign in.
2. DevTools → Application → Cookies → copy the value of the `token` cookie.
3. Add it:

```bash
bun src/cli.ts add https://chat.ai2s.org <paste-jwt-here>
```

Or use opencode's built-in prompt (it'll ask for the token):

```bash
opencode auth login openwebui
```

## Useful commands

```bash
bun src/cli.ts login              # automated Shibboleth + Duo OIDC login
bun src/cli.ts add <url> <jwt>    # manual JWT paste
bun src/cli.ts list               # list accounts
bun src/cli.ts use <name>         # switch current
bun src/cli.ts models             # list models available to your user
bun src/cli.ts whoami             # verify token
bun src/cli.ts remove <name>      # delete account
```

## Auto-refresh

If `OWUI_USERNAME` and `OWUI_PASSWORD` are set in the environment when the
plugin's `fetch` hook is invoked with an expired token, it'll re-run the full
OIDC login automatically (including a Duo Push, which you'll need to approve),
silently replace the stored JWT, and retry the request.

Without those env vars, an expired token returns an error with instructions
to re-run `bun src/cli.ts login`.

## How it works

- **Storage**: `~/.config/opencode/openwebui-accounts.json` (0600, atomic write).
- The plugin registers provider `openwebui` and returns a custom `fetch()` that:
  - rewrites any `*/chat/completions` URL to `{baseUrl}/api/chat/completions`
  - strips Anthropic/OpenAI-specific headers (`x-api-key`, `anthropic-version`, etc.)
  - sets `Authorization: Bearer <JWT>`
  - scrubs Bedrock-incompatible tool fields from request bodies (e.g. Claude's
    strict tool schema metadata that Bedrock rejects)
  - auto-refreshes the JWT on 401 / expiry when env credentials are present
- Forces `stream_options.include_usage = true` via the `chat.params` hook so token
  accounting shows up in opencode's stats.
- JWT expiry is checked locally (`exp` claim) before every request.
- Token is parsed from the `token` cookie set by OWUI's `/oauth/oidc/callback`
  response after successful authentication.

## Environment variables

| Name | Required | Purpose |
| ---- | -------- | ------- |
| `OWUI_BASE_URL` | No | Default base URL when not passed as CLI arg (default: `https://chat.ai2s.org`) |
| `OWUI_USERNAME` | Yes for `login` / auto-refresh | NetID / username |
| `OWUI_PASSWORD` | Yes for `login` / auto-refresh | Account password |
| `OWUI_DUO_PASSCODE` | Optional | 6-digit Duo Mobile passcode (if unset, sends Duo Push) |
| `OPENWEBUI_AUTH_DEBUG` | Optional | Set to any truthy value for verbose stderr logging |

## Logs

- `~/.config/opencode/openwebui-auth.log` — always
- Set `OPENWEBUI_AUTH_DEBUG=verbose` to also print to stderr
- Request/response bodies are logged in full when debug is enabled

## Troubleshooting

**`message_enum: 57` (SESSION_EXPIRED) on `/prompt/data`** — the Duo state machine
didn't advance. The flow requires *two* identical POSTs to
`/frame/frameless/v4/auth` with a `healthcheck/data` + `/return` cycle in between;
the plugin does this automatically. If you see this, your `sid` or `_xsrf` cookie
is probably stale — rerun `login` from scratch.

**`message_enum: 75` (UNKNOWN_METHOD) on `/prompt`** — the `factor` value wasn't
recognized. Duo's API uses `"Passcode"` (not the UI label `"Duo Mobile Passcode"`)
for any passcode-type auth. The plugin handles this correctly.

**`Step 5: No token cookie received`** — Shibboleth completed the OIDC dance but
OWUI didn't set the `token` cookie. Verify the OWUI host is reachable and that
`/oauth/oidc/callback` returns 307 with a `Set-Cookie: token=...` header.

**Token expired but no auto-refresh** — set `OWUI_USERNAME` + `OWUI_PASSWORD` in
your environment (and `OWUI_DUO_PASSCODE` if you don't want to approve a push).

## Security

- Zero keys are stored in the code. The only secrets are your NetID password
  (via env vars, never written to disk) and your personal JWT (persisted at
  `~/.config/opencode/openwebui-accounts.json` with mode `0600`).
- Credentials are only sent to the configured `baseUrl` and its Shibboleth/Duo
  upstreams (`shibboleth.arizona.edu`, `api-*.duosecurity.com` for Arizona).
- The plugin never sends the JWT to anything other than the configured `baseUrl`.
- The `_xsrf` cookie value used for Duo's CSRF protection is base64-decoded from
  the signed server cookie and used as the `X-Xsrftoken` header on AJAX calls,
  mirroring what Duo's `App.js` React bundle does client-side.
