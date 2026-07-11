# ⚡ Grouter

### Universal AI Gateway — One Endpoint, Every Provider

**Circuit breaker resilience · RTK token compression · 40+ providers · SSE streaming**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](./package.json)

[🚀 Quick Start](#-quick-start) • [📦 Beginner Setup](#-beginner-setup-guide) • [🛠 CLI Tools](#-supported-cli-tools) • [🖥 Tech Stack](#-tech-stack) • [📁 Structure](#-project-structure) • [🙏 Credits](#-credits--references)

---

## 🤔 Why Grouter?

**Stop wasting money, tokens, and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ 1 provider error = all accounts blocked

**Grouter solves this:**

- ✅ **RTK Token Saver** — Auto-compress tool_result content, save 20-40% tokens
- ✅ **Circuit Breaker** — Dead provider? Trip the breaker, route to next one. No cascade.
- ✅ **Account Semaphore** — Per-account concurrency limiter prevents hammering one account
- ✅ **Quota Auto-Reactivation** — Credits run out → auto-parked → auto-reactivated
- ✅ **Proxy-Aware Resilience** — One dead proxy doesn't block accounts on other proxies
- ✅ **Per-API-key ACL** — Hand out keys scoped to specific providers/combos/kinds
- ✅ **40+ Providers** — Kimchi, GitHub Copilot, Codex, Gemini, OpenRouter, NVIDIA, and more

---

## 🚀 Quick Start

### From Source

```bash
git clone https://github.com/gradle-development/grouter.git
cd grouter
pnpm install
cp .env.example .env
pnpm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
pnpm start
```

Open `http://localhost:3003/dashboard`, add provider connections, generate an API key, and point your CLI to `http://localhost:3003/v1`.

### PM2 (production)

```bash
npm install -g pm2
PORT=3003 pm2 start server.js --name grouter
pm2 save
```

### Docker

```bash
docker run -d \
  -p 3003:3003 \
  -v grouter-data:/home/node/.grouter \
  --name grouter \
  ghcr.io/gradle-development/grouter:latest
```

---

## 📦 Beginner Setup Guide

<details>
<summary><b>🪟 Windows</b></summary>

### 1. Install Node.js
Download LTS from https://nodejs.org, check "Add to PATH". Verify:

```cmd
node --version
npm --version
```

### 2. Install pnpm

```cmd
npm install -g pnpm
```

### 3. Install Git
Download from https://git-scm.com/download/win.

### 4. Clone & Install

```cmd
git clone https://github.com/gradle-development/grouter.git
cd grouter
copy .env.example .env
pnpm install
```

### 5. Configure `.env`

```
JWT_SECRET=your-random-secret-at-least-32-chars
INITIAL_PASSWORD=your-password
DATA_DIR=C:\Users\YourName\.grouter
PORT=3003
NODE_ENV=production
NEXT_PUBLIC_BASE_URL=http://localhost:3003
```

### 6. Build & Run

```cmd
pnpm run build
pnpm start
```

Open: http://localhost:3003

### Auto-start with PM2

```cmd
npm install -g pm2 pm2-windows-startup
pm2 start server.js --name grouter
pm2-startup install
pm2 save
```

</details>

<details>
<summary><b>🐧 Linux / WSL</b></summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm

git clone https://github.com/gradle-development/grouter.git
cd grouter
cp .env.example .env
pnpm install

nano .env  # set JWT_SECRET, INITIAL_PASSWORD, PORT

pnpm run build
cp -r public .next/standalone/public
cp -r .next/static .next/standalone/.next/static
pnpm start
```

### PM2

```bash
npm install -g pm2
PORT=3003 pm2 start server.js --name grouter
pm2 startup && pm2 save
```

</details>

<details>
<summary><b>🐳 Docker</b></summary>

```bash
docker run -d \
  -p 3003:3003 \
  -v "$HOME/.grouter:/app/data" \
  -e DATA_DIR=/app/data \
  --name grouter \
  ghcr.io/gradle-development/grouter:latest
```

Or `docker compose up -d`.

</details>

---

## 🧪 Browser Engine Setup

Grouter's automation jobs (bulk import, Google OAuth) run via Python subprocess using Playwright.

### Install

```bash
pip install -r scripts/python/requirements.txt
```

### Engine Options

| Engine | Install | Notes |
|--------|---------|-------|
| **Chromium** (default) | `playwright install chromium` | Bundled with Playwright, zero config |
| **CloakBrowser** | `pip install cloakbrowser` | Anti-detect Chromium fork, fingerprint randomized per session |

CloakBrowser auto-downloads its binary on first launch (~200MB, cached at `~/.cloakbrowser`).

### Manual Test

```bash
python3 -m autoclaw user@gmail.com pass123 --engine chromium
python3 -m autoclaw user@gmail.com pass123 --engine cloakbrowser --proxy socks5://user:pass@host:port
```

---

## ☁️ Cloudflare Worker

Grouter ships with a Cloudflare Email Inbox Worker for catch-all email routing — used by OAuth account creation flows.

### Deploy

```bash
cd cf-workers
npx wrangler deploy
```

### What It Does

- Catch-all email inbox via Cloudflare Email Routing + KV
- Creates disposable addresses (`cf-xxx@yourdomain.com`)
- API: `GET /api/messages?addr=xxx` to read inbox

### Configuration

Edit `cf-workers/wrangler.jsonc`:
```jsonc
{
  "name": "grouter-email-inbox",
  "kv_namespaces": [
    { "binding": "INBOX", "id": "your-kv-id" }
  ],
  "vars": {
    "DOMAIN": "yourdomain.com"
  }
}
```

Set `CLOUDFLARE_API_TOKEN` in `cf-workers/.env`.

---

## 🛠️ Supported CLI Tools

| Tool | Config Path |
|------|-------------|
| **Claude Code** | `~/.claude/settings.json` |
| **Codex** | `~/.codex/config.json` |
| **Cursor** | Settings → Models → OpenAI API |
| **Cline** | VS Code extension settings |
| **OpenCode** | `opencode.json` |
| **GitHub Copilot** | VS Code extension |
| **Gemini CLI** | `~/.gemini/config.json` |
| **Kilo Code** | Kilo settings |
| **Roo Code** | Roo settings |
| **Continue** | Continue config |
| **Aider** | Aider config |
| **Droid** | Droid config |

Any tool supporting OpenAI/Claude-compatible API works.

---

## 🖥 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 16 (standalone output) |
| **Runtime** | Node.js 20+ / Bun |
| **Database** | better-sqlite3 (fallback: sql.js, node:sqlite, bun:sqlite) |
| **Process Manager** | PM2 |
| **Container** | Docker / docker-compose |
| **Testing** | Vitest |
| **Language** | JavaScript ESM |
| **Package Manager** | pnpm |
| **Browser Automation** | Playwright (Chromium / CloakBrowser) |
| **Edge Workers** | Cloudflare Workers (email inbox) |

---

## 📁 Project Structure

```
grouter/
├── src/                          # Next.js app
│   ├── app/                      # Dashboard + API routes
│   ├── lib/                      # DB, OAuth, utilities
│   ├── shared/                   # Constants, components, hooks
│   └── sse/                      # SSE handlers (chat, tts, image, etc)
├── open-sse/                     # Provider-agnostic SSE engine
│   ├── config/                   # Providers, models, runtime constants
│   ├── executors/                # Per-provider upstream calls
│   ├── handlers/                 # Core handlers (chatCore, sttCore, etc)
│   ├── translator/               # Format conversion (request/, response/)
│   ├── providers/                # Registry + capabilities + pricing
│   ├── rtk/                      # Token savers (caveman, ponytail)
│   └── services/                 # tokenRefresh, usage, combo, accountFallback
├── cf-workers/                   # Cloudflare Workers (email inbox)
├── cli/                          # CLI launcher package
├── scripts/                      # Build, migration, automation
│   └── python/autoclaw/          # Playwright-based OAuth automation
├── tests/                        # Vitest test suites
├── public/                       # Static assets
├── i18n/                         # Translations
└── docs/                         # Architecture & migration docs
```

---

## 🙏 Credits & References

Grouter is a fork that builds on the work of excellent open-source projects:

- **[9router](https://github.com/decolua/9router)** by [@decolua](https://github.com/decolua) — the foundation: provider registry, RTK token saver, format translation, combo strategies, per-API-key ACL, Kimi native tool parser, NVIDIA stream coercion. Grouter retains full format compatibility.

- **[VansRouter](https://github.com/Vanszs/VansRouter)** by [@Vanszs](https://github.com/Vanszs) — the direct upstream: circuit breaker resilience, account semaphore, proxy-aware everything, credential lifecycle automation, loop-guard, Kimchi CLI alignment. Grouter is a hardened fork of VansRouter.

- **[OmniRoute](https://github.com/diegosouzapw/OmniRoute)** by [@diegosouzapw](https://github.com/diegosouzapw) — the resilience inspiration: circuit breaker pattern, account semaphore, provider-level failure tracking.

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — original Go implementation.

Full credit to all projects. Grouter stands on their work.

---

## 📄 License

MIT — see [LICENSE](./LICENSE)
