# 9router — AI Agent Guide

> **Universal API proxy**: One OpenAI-compatible endpoint → 100+ AI providers (LLM, image, TTS, STT, embedding, search). Next.js 16 + standalone output + PM2.

## Quick Start

```bash
pnpm install
pnpm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
PORT=3003 pm2 start .next/standalone/server.js --name 9router
pm2 save
```

Full deployment details: see [`agent.md`](./agent.md)

## Architecture

```
Client (OpenAI format) → /api/v1/* → SSE handlers → Translator → Executor → Provider
                                                                    ↓
                              Response ← Translator (provider → client format)
```

### Request Flow (Chat)
1. `src/sse/handlers/chat.js` — auth, model resolution, retry loop
2. `open-sse/handlers/chatCore.js` — translate, inject RTK/Caveman/Ponytail, execute
3. `open-sse/translator/` — format conversion (OpenAI ↔ Claude/Gemini/Kiro/etc)
4. `open-sse/executors/` — per-provider HTTP calls

## Directory Structure

```
9router/
├── src/                      # Next.js app
│   ├── app/                  # Routes (dashboard, API endpoints)
│   ├── lib/                  # DB, OAuth, utilities
│   ├── shared/               # Shared constants, components, hooks
│   └── sse/handlers/         # SSE request handlers (chat, tts, image, etc)
│
├── open-sse/                 # Provider-agnostic SSE engine (see open-sse/AGENTS.md)
│   ├── config/               # ALL constants (providers, models, runtime)
│   ├── executors/            # Per-provider upstream calls
│   ├── handlers/             # Modality cores (chatCore, sttCore, etc)
│   ├── translator/           # Format conversion (request/, response/, schema/)
│   ├── providers/            # Registry + capabilities + pricing
│   ├── rtk/                  # Token savers (caveman.js, ponytail.js)
│   └── services/             # tokenRefresh, usage, combo, accountFallback
│
├── tests/                    # Vitest test suites
├── public/                   # Static assets
└── cli/                      # CLI tool
```

## Key Conventions

1. **Config-driven**: All constants in `open-sse/config/` and `src/shared/constants/`. Never hardcode.
2. **DRY**: Reuse `translator/schema/`, `translator/concerns/`, `translator/formats/`.
3. **Provider registry**: Add to `open-sse/providers/registry/{id}.js`, regenerate index.
4. **Translator pairs**: Register `request/<from>-to-<to>.js` + `response/<from>-to-<to>.js`.
5. **ESM**: All imports use `.js` extension.

## Adding Features

| Task | Where | Notes |
|------|-------|-------|
| New provider | `open-sse/providers/registry/{id}.js` | Copy REGISTRY_TEMPLATE, add models to `providerModels.js` |
| Custom executor | `open-sse/executors/{name}.js` | Subclass BaseExecutor, register in `index.js` |
| New translator | `open-sse/translator/request\|response/` | Call `register(from, to, fn)`, import in `translator/index.js` |
| Token saver | `open-sse/rtk/{name}.js` | Import in chatCore.js, add to handleChatCore params |
| API endpoint | `src/app/api/{path}/route.js` | Next.js App Router |
| Dashboard UI | `src/app/(dashboard)/dashboard/{page}/` | Client components |

## Custom Features (9router-specific)

- **ACL per API key**: `allowedProviders`, `allowedCombos`, `allowedKinds` in key settings
- **Token Saver**: RTK (compress tool output) + Caveman (terse output) + Ponytail (YAGNI code)
- **Combo strategies**: Fallback, Round Robin, Fusion (parallel + judge), Capacity auto-switch
- **Provider nodes**: Custom OpenAI/Anthropic-compatible providers with UUID suffix

## Testing

```bash
pnpm test                    # All tests
pnpm test tests/unit/        # Unit tests only
pnpm test tests/translator/  # Translator tests
```

## Important Files

| File | Purpose |
|------|---------|
| `src/shared/constants/providers.js` | Provider definitions, aliases, ACL list |
| `src/shared/constants/models.js` | Model definitions per provider |
| `open-sse/config/providers.js` | Provider registry build |
| `open-sse/handlers/chatCore.js` | Core chat handler (RTK/Caveman/Ponytail injection) |
| `src/sse/services/auth.js` | API key validation, ACL checks |
| `src/sse/services/allowedModels.js` | Model access control |

## Troubleshooting

- **502 Bad Gateway**: Check `PORT` env matches Nginx upstream (`pm2 env 9router | grep PORT`)
- **Missing CSS/icons**: Run static copy step after build (see Quick Start)
- **Provider 401/403**: Check token refresh logic in `open-sse/services/tokenRefresh/`
- **Translator errors**: Check format detection in `open-sse/services/provider.js`

## Sub-docs

- [`open-sse/AGENTS.md`](./open-sse/AGENTS.md) — SSE engine details
- [`tests/translator/AGENTS.md`](./tests/translator/AGENTS.md) — Translator testing
- [`agent.md`](./agent.md) — Production deployment (Indonesian)
- [`DOCKER.md`](./DOCKER.md) — Docker deployment
- [`CHANGELOG.md`](./CHANGELOG.md) — Version history
