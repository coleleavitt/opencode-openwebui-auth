# opencode-openwebui-auth

opencode plugin that routes `chat/completions` traffic through an
[OpenWebUI](https://github.com/open-webui/open-webui) instance, using your
existing user JWT instead of a direct provider API key.

Useful when the models (Anthropic, Bedrock, OpenAI, etc.) are not directly
reachable from your machine but are exposed through an OWUI deployment you
already have a browser session for — e.g. a university or company LLM gateway.

Zero runtime dependencies — bundles into a single ESM file.

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
    "file:///home/you/opencode-openwebui-auth/dist/bundle.js"
  ],
  "provider": {
    "openwebui": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenWebUI",
      "options": {
        "baseURL": "https://your-openwebui-instance.example.org/api"
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

## Authentication

### Browser SSO login (recommended)

The primary auth method opens a browser-based SSO/OIDC flow. Run:

```bash
bun src/cli.ts login https://your-openwebui-instance.example.org
```

This starts a local HTTP server and opens a bridge page in your browser that
guides you through:

1. SSO/OIDC sign-in in your browser
2. Token extraction via `copy(localStorage.token)` in the browser console
3. Pasting the token back into the bridge page

The CLI waits for the token, validates it, and saves the account automatically.

You can also set `OWUI_BASE_URL` so you don't have to type the URL every time:

```bash
export OWUI_BASE_URL=https://your-openwebui-instance.example.org
bun src/cli.ts login
```

### Manual token (fallback)

For non-SSO setups or when the browser flow fails, manually paste your JWT:

```bash
bun src/cli.ts add https://your-openwebui-instance.example.org <paste-jwt-here>
```

To get the token manually:
1. Open your OpenWebUI instance in a browser and sign in
2. DevTools → Application → Local Storage → copy the value of `token`
3. Run the `add` command above

## CLI commands

All commands are run via `bun src/cli.ts <command>`:

```
login [baseUrl]           Sign in via browser (SSO/OIDC) — opens your browser
add <baseUrl> <token>     Add/update an OpenWebUI account (manual token paste)
list                      List configured accounts
use <name>                Set the current account
remove <name>             Delete an account
models [name]             List models for the given (or current) account
whoami                    Print the current account and verify token
```

## Build commands

```bash
bun install
bun run build             # typecheck + bundle plugin + bundle CLI
bun run build:typecheck   # typecheck only (no emit)
bun run build:bundle      # bundle only (skip typecheck)
bun run dev               # watch mode typecheck
bun run lint              # lint with Biome
bun run lint:fix          # lint + auto-fix
bun run format            # format with Biome
```

## Environment variables

- `OWUI_BASE_URL` — base URL for OpenWebUI instance (fallback when not provided as arg)
- `OPENWEBUI_AUTH_DEBUG=verbose` — enable debug logging to stderr

## How it works

- Storage: `~/.config/opencode/openwebui-accounts.json` (0600, atomic write)
- The plugin registers provider `openwebui` and returns a custom `fetch()` that:
  - rewrites any `*/chat/completions` URL to `{baseUrl}/api/chat/completions`
  - strips Anthropic/OpenAI-specific headers (`x-api-key`, `anthropic-version`, etc.)
  - sets `Authorization: Bearer <JWT>`
- Forces `stream_options.include_usage = true` via the `chat.params` hook so token
  accounting shows up in opencode's stats.
- JWT expiry is checked locally (exp claim) before every request; an expired
  token returns an error with instructions to re-auth — OWUI does not expose a
  refresh endpoint for user JWTs, so you re-authenticate when it expires.
- The browser SSO flow uses a local HTTP server and bridge page to extract tokens
  from the browser after OIDC/SSO sign-in, then POSTs them back to the CLI.

## Logs

- `~/.config/opencode/openwebui-auth.log` — always
- Set `OPENWEBUI_AUTH_DEBUG=verbose` to also print to stderr

## Security

- Zero keys are stored in the code. The only secret is your personal JWT,
  persisted at `~/.config/opencode/openwebui-accounts.json` with mode `0600`.
- The plugin never sends the JWT to anything other than the configured `baseUrl`.
- The browser SSO flow uses a local HTTP server (localhost only) with a short-lived
  bridge page — no external servers are involved in the authentication flow.
