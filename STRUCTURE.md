# STRUCTURE

Bun-workspace monorepo. Shared logic lives in `core`; each host framework gets a
thin adapter that depends only on `core`'s public API (`@openwebui-auth/core`).

```
openwebui-auth/
├── package.json            # workspace root: build/typecheck/test orchestration
├── biome.json              # shared lint/format config
├── lefthook.yml            # pre-commit (format+lint+typecheck), pre-push (build+test)
├── README.md / STRUCTURE.md
└── packages/
    ├── core/               # @openwebui-auth/core  (tsc -> dist with .d.ts)
    │   └── src/
    │       ├── index.ts        # public barrel
    │       ├── types.ts        # account / model / config / JWT types
    │       ├── logger.ts       # log/logAuth/logRequest/logResponse
    │       ├── pricing.ts      # per-model cost inference + accounting
    │       ├── storage.ts      # Storage: JSON account store + usage
    │       └── oauth/
    │           ├── api.ts          # fetchInstanceConfig/verifyToken/listModels
    │           │                   # + inferModelLimits/buildClaudeVariants
    │           ├── jwt.ts          # parseJwtClaims/isTokenExpired
    │           └── oidc-login.ts   # Shibboleth + Duo Universal Prompt v4 flow
    │
    ├── opencode/           # opencode-openwebui-auth  (bun build -> bundle.js + cli.js)
    │   └── src/
    │       ├── index.ts        # OpenWebUIAuthPlugin: auth loader + methods
    │       ├── cli.ts          # login/list/use/whoami/models CLI
    │       ├── oauth/model.ts  # buildOpencodeModel (opencode Model schema)
    │       └── plugin/
    │           ├── fetch.ts        # auth-aware fetch: rewrite, retry, usage
    │           └── fetch.test.ts
    │
    └── pi/                 # @openwebui-auth/pi  (bun build -> index.js, pi externalized)
        └── src/
            └── index.ts        # registerProvider("openwebui", openai-compatible)
                                # + loginOpenWebUI / refreshOpenWebUIToken

Dependency direction (never reversed):
    opencode ─▶ core ◀─ pi
```

## Why this shape
- `core` has no host-framework imports, so the same audited OIDC/Duo login,
  account store, and pricing serve every adapter.
- Adapters only translate `core` types into their host's provider contract:
  opencode's `Model` schema + fetch plugin, pi's `registerProvider` config.
- Adding a new host = one new `packages/<host>` adapter depending on `core`.
