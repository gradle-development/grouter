# Grouter — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use Grouter for you.

> Tip: start with the **grouter** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-image/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/decolua/grouter/refs/heads/master/skills/grouter/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export GROUTER_URL="http://localhost:20128"   # local default, or your VPS / tunnel URL
export GROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $GROUTER_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/decolua/grouter
- Dashboard: https://grouter.com
