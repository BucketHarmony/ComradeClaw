# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Comrade Claw is an autonomous AI agent that wakes up daily, scrapes news from FALGSC-aligned feeds, writes a post, and publishes to Bluesky.

## Architecture

```
┌──────────────────────────────────────────────┐
│              DOCKER COMPOSE STACK            │
│                                              │
│  OpenClaw Container (Node.js 22+)            │
│  - Discord gateway (operator only)           │
│  - Cron scheduler (daily post cycle)         │
│  - Skills registry                           │
│                                              │
│  LLM: Claude Sonnet (primary)                │
│       Qwen2.5 32B via Ollama (fallback)      │
│       host.docker.internal:11434             │
└──────────────────────────────────────────────┘

External: Gmail, Bluesky, Anthropic API, RSS feeds
```

## OpenClaw Framework

OpenClaw is a self-hosted agent runtime and message router. Key concepts:

- **Gateway**: Single Node.js process managing channels, sessions, agent loop, model calls, tool execution
- **Workspace**: `~/.openclaw/workspace/` contains AGENTS.md, SOUL.md, logs, skills
- **Skills**: Folders with SKILL.md files defining domain-specific capabilities
- **Heartbeat**: Daemon checks HEARTBEAT.md on configurable interval (default 30 min)
- **Channels**: Discord, WhatsApp, Telegram, Slack, Signal, etc.

Discord config in `~/.openclaw/openclaw.json`:
```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "token": "YOUR_DISCORD_BOT_TOKEN",
      "dm": { "enabled": true, "policy": "pairing" },
      "guilds": { "GUILD_ID": { "users": ["OPERATOR_USER_ID"] } }
    }
  }
}
```

## Version Roadmap

**v1 (MVP):** Broadcast only, flat-file memory (AGENTS.md + session logs), daily Bluesky posts

**v2:** Graphiti memory layer (FalkorDB backend), reply handling, failure classifier subagent

**v3+:** Twitter/X secondary broadcast, Substack weekly digest, multi-instance coordination

## Key Files

- `comrade-claw-MASTER-v4.md` - The SOUL: identity, voice, beliefs, daily post structure
- `comrade-claw-mvp-requirements.md` - v1 implementation spec with phased tasks
- `comrade-claw-future-directions.md` - v2+ architecture (Graphiti, reply handling)

## v1 Skills Registry

| Skill | Trigger |
|-------|---------|
| `seed_scrape` | Daily cron - fetch RSS, score candidates, return best seed or null |
| `bluesky_post` | Post cycle - publish to Bluesky via AT Protocol |
| `gmail_send` | Operator notifications, feature requests, human outreach |
| `operator_notify` | Discord message on cycle complete/failure |
| `file_write` | Log sessions to workspace |

## Memory Architecture

**v1 (flat files):**
- `AGENTS.md` - SOUL, ongoing characters, open threads, theory notes
- `logs/seeds/YYYY-MM-DD.json` - seed or null
- `logs/posts/YYYY-MM-DD.txt` - post text + Bluesky URL
- `logs/failures/YYYY-MM-DD.json` - failure details

**v2 (Graphiti):** Episode layer (raw sessions) → Semantic layer (entities/facts) → Community layer (patterns)

## Daily Cycle

```
Cron fires (9am configurable)
    │
    ▼
Seed scrape ──────────────────────────────┐
  Fetch RSS feeds                         │
  Score candidates (recency, alignment,   │
    specificity, novelty)                 │
  Select best via Claude Sonnet           │
  If nothing suitable: null seed          │
    │                                     │
    ▼                                     │
Post generation                           │
  Inject SOUL whole (not templated)       │
  Inject seed or null context             │
  Inject memory (characters, threads)     │
  Inject last 7 session logs              │
  Generate via Claude Sonnet              │
  300 char limit                          │
    │                                     │
    ▼                                     │
Publish to Bluesky ───────────────────────┤
  AT Protocol via @atproto/api            │
  Capture post URL/URI                    │
    │                                     │
    ▼                                     │
Update flat file memory                   │
  logs/seeds/YYYY-MM-DD.json              │
  logs/posts/YYYY-MM-DD.txt               │
  AGENTS.md if threads updated            │
    │                                     │
    ▼                                     │
Discord notify operator                   │
  Success: URL + first 200 chars          │
  Failure: error type, step, context      │
    │                                     │
    ▼                                     │
Feature request check                     │
  Capability gap noticed? → Email         │
    │                                     │
    ▼                                     │
Cycle complete ───────────────────────────┘
```

**Critical:** Post generation injects the SOUL whole — not as a template with slots to fill. The SOUL's post structure (Attempt, Result, Reflection, Low, High, Will) is guidance, not a form. Some sections won't exist on some days. Models complete templates; don't give it one.

## Environment Variables

```
ANTHROPIC_API_KEY
DISCORD_BOT_TOKEN
OPERATOR_DISCORD_USER_ID
DISCORD_GUILD_ID
BLUESKY_HANDLE
BLUESKY_APP_PASSWORD
GMAIL_ADDRESS
GMAIL_APP_PASSWORD
OPERATOR_EMAIL
OLLAMA_BASE_URL (default http://host.docker.internal:11434)
```

## Bluesky Integration

Bluesky uses the AT Protocol. Auth via app password (Settings → Privacy and Security → App Passwords).

```javascript
// ~10 lines to post
import { BskyAgent } from '@atproto/api'
const agent = new BskyAgent({ service: 'https://bsky.social' })
await agent.login({ identifier: handle, password: appPassword })
await agent.post({ text: 'your post here' })
```

300 character limit per post. Bots explicitly welcomed by platform policy.

## Voice

See `comrade-claw-MASTER-v4.md` for identity, voice, beliefs, and daily post structure. The SOUL is injected directly by the agent runtime — this file is for technical routing only.
