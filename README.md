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

The plugin is **near-zero-config**. Just declare the provider exists with one
empty stub and the plugin auto-fetches your model list, auto-sets the baseURL,
auto-picks the OpenAI-compatible adapter, and auto-zeroes the costs (the OWUI
instance owner pays, not you):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///home/you/WebstormProjects/opencode-openwebui-auth/dist/bundle.js"
  ],
  "provider": {
    "openwebui": {}
  }
}
```

That's it — no `npm`, no `baseURL`, no `models` map. After running
`opencode auth login openwebui` once, every model your OWUI account can see
(including new ones added by the admin later) shows up on the next opencode
start. No config edit required.

### Why is the empty `{}` needed?

opencode resolves providers in this order (from `provider/provider.ts:1001`):

1. Snapshots `cfg.provider` keys into a `configProviders` array
2. Builds a database from `models.dev` catalog + extends it with `configProviders`
3. Calls `Plugin.list()` which fires plugin hooks (including ours)
4. For each plugin with `auth.loader`, looks up `database[providerID]` and
   passes it to the loader

If `openwebui` isn't in `cfg.provider` at step 1, the database never gets an
entry, and at step 4 our loader receives `undefined` — so we can't populate
models. The `"openwebui": {}` stub satisfies step 1 with the absolute minimum
content; everything else (name, npm, baseURL, models) is left to defaults
or to our loader.

### Optional overrides

To pin a name, blacklist models, set custom limits, etc., extend the stub.
Anything you specify takes precedence over what the plugin discovers;
everything else stays dynamic:

```jsonc
{
  "plugin": ["file:///.../bundle.js"],
  "provider": {
    "openwebui": {
      "name": "Arizona AI Gateway",        // custom display name
      "blacklist": ["openai.gpt-oss-120b-1:0"],  // hide specific models
      "models": {
        "bedrock-claude-4-6-opus": {
          "name": "Claude Opus 4.6 (UA)",   // override discovered name
          "limit": { "context": 200000, "output": 16384 }
        }
      }
    }
  }
}
```

### How the dynamic injection works (peek under the hood)

Once the user has authenticated (so `auth.get("openwebui")` resolves),
opencode invokes our `auth.loader(getAuth, providerInfo)` (registered against
the `openwebui` provider you declared in opencode.json):

- We fetch `GET /api/models` from the user's OWUI instance with their JWT.
- For each model, we build a fully-populated `Model` object matching opencode's
  `provider/provider.ts:777` Zod schema and write it to `provider.models[id]`.
  Capabilities (vision/files/tools) are derived from OWUI's
  `info.meta.capabilities` flags.
- Cost is `0` for every field — the OWUI instance owner is paying upstream.
- We return `{ baseURL, apiKey, fetch }` and opencode's `mergeProvider()`
  merges them into `provider.options`.
- Standard provider resolution takes over: blacklist filtering, variant
  generation, SDK adapter loading (defaulting to `@ai-sdk/openai-compatible`).

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

### Option 3 — `opencode auth login` (interactive)

The plugin registers itself with opencode's built-in auth UI. Run:

```bash
opencode auth login openwebui
```

You'll be prompted to choose between:

- **Automated OIDC (Shibboleth + Duo 2FA)** — same flow as `bun src/cli.ts login`,
  but with interactive prompts for username, password, and Duo method (push or
  passcode). Env vars (`OWUI_USERNAME`, `OWUI_PASSWORD`, `OWUI_DUO_PASSCODE`)
  are honored as fallbacks if you press Enter on a prompt.
- **Paste OpenWebUI JWT manually** — for non-Shibboleth instances. Validates
  that the input is a 3-segment JWT before saving.

## Useful commands

```bash
bun src/cli.ts login                          # automated Shibboleth + Duo OIDC login
bun src/cli.ts add <url> <jwt>                # manual JWT paste
bun src/cli.ts list                           # list accounts
bun src/cli.ts use <name>                     # switch current
bun src/cli.ts models                         # list models (id + name only)
bun src/cli.ts models --verbose               # list with owner, connection, capabilities
bun src/cli.ts models --json                  # full /api/models JSON dump
bun src/cli.ts config                         # show OWUI instance name/version/features
bun src/cli.ts whoami                         # verify token + show user identity
bun src/cli.ts remove <name>                  # delete account
```

The `models --verbose` view uses a compact capability bitmap: `V`=vision,
`F`=file upload, `W`=web search, `C`=code interpreter, `T`=builtin tools,
`Q`=citations, `U`=usage tracking. A `·` means the capability is off for
that model. Example:

```
ID                                    OWNER     CONN      CAPS     NAME
bedrock-claude-4-6-opus               openai    external  VFWCTQU  Anthropic - Claude Opus 4.6
openai.gpt-oss-120b-1:0               openai    external  ·FWCTQU  OpenAI - GPT OSS 120B
```

## Endpoints used

| OWUI endpoint                | Used for                                    |
| ---------------------------- | ------------------------------------------- |
| `GET /api/models`              | List all models accessible to the user      |
| `GET /api/v1/auths/`           | Verify token + fetch user identity (whoami) |
| `GET /api/config`              | Instance metadata (name, version, features) |
| `POST /api/chat/completions`   | Chat (rewritten URL from any provider call) |
| `GET /oauth/oidc/login`        | Initiate the Shibboleth OIDC flow           |
| `GET /oauth/oidc/callback`     | Receives the JWT cookie after Shib + Duo    |
<!-- table not formatted: invalid structure -->

These are all the canonical endpoints from `open-webui/backend/open_webui/main.py`
(`/api/models` is at `main.py:1469`).

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
