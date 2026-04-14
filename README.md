# opencode-openwebui-auth

opencode plugin that routes `chat/completions` traffic through an
[OpenWebUI](https://github.com/open-webui/open-webui) instance, using your
existing user JWT instead of a direct provider API key.

Useful when the models (Anthropic, Bedrock, OpenAI, etc.) are not directly
reachable from your machine but are exposed through an OWUI deployment you
already have a browser session for — e.g. a university or company LLM gateway.

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

## Grab a token

1. Open your OpenWebUI instance in a browser and sign in.
2. DevTools → Application → Cookies → copy the value of the `token` cookie.

## Add the account

```bash
bun src/cli.ts add https://chat.ai2s.org <paste-jwt-here>
```

Or in opencode:

```bash
opencode auth login openwebui
```

## Useful commands

```bash
bun src/cli.ts list               # list accounts
bun src/cli.ts use <name>         # switch current
bun src/cli.ts models             # list models available to your user
bun src/cli.ts whoami             # verify token
```

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
  refresh endpoint for user JWTs, so you re-paste when it expires.

## Logs

- `~/.config/opencode/openwebui-auth.log` — always
- Set `OPENWEBUI_AUTH_DEBUG=verbose` to also print to stderr

## Security

- Zero keys are stored in the code. The only secret is your personal JWT,
  persisted at `~/.config/opencode/openwebui-accounts.json` with mode `0600`.
- The plugin never sends the JWT to anything other than the configured `baseUrl`.
