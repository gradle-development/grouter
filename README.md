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

## ☁️ Cloudflare Worker (temp mail / Email Routing)

Two mail backends. Pick by automation flow:

| Goal | Backend | API shape |
|------|---------|-----------|
| **Cloudflare AI** disposable signup | In-repo `cf-workers/` (this section) | `/api/address`, `/api/messages` |
| **Grok** auto-register | External [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email) | `/api/new_address`, `/api/mails` |

### A) In-repo worker — CF Email Routing catch-all

Used by **Automation → Cloudflare AI → Disposable Email Signup** (`cf-email` mode). Domain must be on Cloudflare.

#### 1. Domain

Cloudflare Dashboard → your domain → **Email** → **Email Routing** → enable.

#### 2. KV namespace

```bash
cd cf-workers
npx wrangler login
npx wrangler kv namespace create INBOX
```

Copy the printed `id` into `cf-workers/wrangler.jsonc`:

```jsonc
{
  "name": "9router-email-inbox",
  "main": "email-inbox-worker.js",
  "compatibility_date": "2025-01-01",
  "kv_namespaces": [
    { "binding": "INBOX", "id": "PASTE_KV_ID_HERE" }
  ],
  "vars": {
    "DOMAIN": "yourdomain.com"
  }
}
```

#### 3. Token + deploy

```bash
# cf-workers/.env  (do not commit)
CLOUDFLARE_API_TOKEN=your_token_with_workers_edit

npx wrangler deploy
```

Worker URL looks like `https://9router-email-inbox.<account>.workers.dev` (or your custom route).

#### 4. Email Routing → Worker

Dashboard → domain → **Email Routing** → **Routing rules** → Catch-all → **Send to a Worker** → select the deployed worker.

#### 5. Smoke test

```bash
# generate address
curl "https://YOUR-WORKER.workers.dev/api/address?domain=yourdomain.com"

# send a test mail to that address, then:
curl "https://YOUR-WORKER.workers.dev/api/messages?addr=cf-xxx@yourdomain.com"
```

API:

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/address?domain=&local=` | `{address}` |
| `GET` | `/api/messages?addr=` | `[{from,subject,text,html,receivedAt}]` |
| `GET` | `/api/messages/:id/raw?addr=` | `{html}` |
| `DELETE` | `/api/messages?addr=` | clear inbox |

#### 6. Dashboard

**Automation → Cloudflare AI → Disposable Email Signup → CF Email Routing**

- **Worker URL** = deploy URL  
- **Domain** = `yourdomain.com`

### B) Grok auto-register temp mail

Grok (`python -m grokreg` / **Automation → Grok**) does **not** use the in-repo worker as-is. It expects a [cloudflare_temp_email](https://github.com/dreamhunter2333/cloudflare_temp_email)-compatible API:

| Path | Role |
|------|------|
| `POST /api/new_address` | create inbox → `{address, jwt}` |
| `GET /api/mails` | list mail (JWT) |

Deploy that project (or compatible fork) separately, then:

```bash
PYTHONPATH=scripts/python python3 -m grokreg register \
  --mail-provider cloudflare \
  --cloudflare-api-base "https://your-temp-mail-worker.example.com" \
  --domain "mail.example.com"
```

Or in the Grok modal: **CF Mail API Base** + **Default Domain(s)** (+ optional admin key / auth mode).

Env shortcuts: `GROK_CF_MAIL_API`, `GROK_MAIL_DOMAIN`, `GROK_CF_MAIL_KEY`, `GROK_CF_MAIL_AUTH`.

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
