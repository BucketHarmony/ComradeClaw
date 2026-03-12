# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Comrade Claw is an autonomous AI agent that wakes up daily, searches for FALGSC-aligned content, writes journal entries, and publishes to Bluesky. The system runs on Node.js with Discord and CLI interfaces.

---

# CURRENTLY IMPLEMENTED

## Architecture (Current)

```
┌──────────────────────────────────────────────┐
│              NODE.JS APPLICATION              │
│                                               │
│  src/index.js        - Discord bot + scheduler│
│  src/scheduler.js    - Five daily wakes (cron)│
│  src/orchestrator.js - Planner/worker dispatch│
│  cli.js              - CLI interface          │
│  src/chat.js         - Shared Claude API+tools│
│  src/tools.js        - AI tool implementations│
│  src/commands.js     - Operator commands      │
│                                               │
│  LLM: Claude Sonnet via Anthropic API         │
│  Search: Brave Search API (free tier)         │
└──────────────────────────────────────────────┘

Interfaces: Discord (operator DM), CLI
Autonomous: Five scheduled wakes per day
Storage: Flat files in workspace/
```

### Wake Execution Flow (Orchestrator)

Wakes use a planner/worker architecture to prevent cognitive overload:

```
PLANNER (Claude call, one tool: plan_wake)
  ↓ saves plan to workspace/plans/
ORCHESTRATOR (JavaScript, reads plan file)
  ↓ for each pending task:
  WORKER (Claude call, filtered tools per task type)
  ↓ orchestrator marks task done, writes summary
  ↓ next task gets prior results as context
ORCHESTRATOR updates plan status → "complete"
  ↓ notifies operator via Discord
```

- **Planner** decides what to do (gets SOUL, memory, wake history, one tool: `plan_wake`)
- **Orchestrator** dispatches workers (JavaScript code, no LLM)
- **Workers** execute one task each in clean contexts with only the tools they need
- **Plan files** are persistent artifacts in `workspace/plans/YYYY-MM-DD_<label>.json`

Worker types: `check_inbox`, `respond`, `search`, `journal`, `distribute`, `memory`, `send_email`, `nothing`

## Working Features

### Interfaces
- **Discord Bot**: Operator-only DM interface, persistent conversation history
- **CLI**: Local terminal interface, same conversation history as Discord
- **Shared History**: Both interfaces share `workspace/logs/chat/` for continuity

### Scheduled Wakes (Autonomous Operation)
Five daily wakes — Claw decides what to do at each:

| Wake | Time | Description |
|------|------|-------------|
| Morning | 9:00 AM | First look at the day |
| Noon | 12:00 PM | Midday check |
| Afternoon | 3:00 PM | The day has shape |
| Evening | 6:00 PM | Natural posting time |
| Night | 11:00 PM | Close the day |

- Planner decides what each wake is for, creates a task plan
- Workers execute tasks one at a time in focused contexts
- Empty wakes are valid — the rhythm is not prescribed
- Prior wake plans shown to planner for continuity
- Plan files saved to `workspace/plans/` for inspection
- Operator notified after each wake via Discord with plan summary

### AI Tools (Available to Claw)
| Tool | Status | Context | Description |
|------|--------|---------|-------------|
| `web_search` | Working | chat, worker(search) | Brave Search API (2000 queries/month free tier) |
| `journal_write` | Working | chat, worker(journal) | Writes to `workspace/logs/journal/` with timestamps |
| `memory_update` | Working | chat, worker(memory) | Updates characters, threads, or theory files |
| `read_memory` | Working | chat, worker(journal,memory) | Reads characters, threads, or theory files |
| `read_journal` | Working | chat, worker(journal) | Reads recent journal entries |
| `bluesky_post` | Implemented | chat, worker(distribute) | Posts to Bluesky (requires credentials) |
| `read_replies` | Implemented | chat, worker(check_inbox) | Reads Bluesky replies, mentions, quotes |
| `bluesky_reply` | Implemented | chat, worker(respond) | Replies to a Bluesky post (requires credentials) |
| `send_email` | Implemented | chat, worker(send_email) | Sends email via Gmail (defaults to operator) |
| `read_email` | Implemented | chat, worker(check_inbox) | Reads inbox via IMAP (requires Gmail credentials) |
| `plan_wake` | Working | planner only | Creates task plan for a wake (orchestrator-internal) |

### Memory System
- **SOUL**: `workspace/SOUL.md` - Core identity, voice, tool instructions
- **Characters**: `workspace/memory/characters.md` - People who became real
- **Threads**: `workspace/memory/threads.md` - Situations developing
- **Theory**: `workspace/memory/theory.md` - Positions evolved through work
- **Journals**: `workspace/logs/journal/YYYY-MM-DD_HH-MM-SS.md`

### Day Counter
- Calendar-based day counting (days since March 11, 2026)
- Multiple journal entries per day supported
- Day number included in system prompt

### Operator Commands
| Command | Description |
|---------|-------------|
| `status` | Shows day number and today's wake summary |
| `clear` | Clears conversation history |
| `wake` | Trigger a wake now (or `wake morning`, `wake noon`, etc.) |
| `wakes` | Show today's wake summary |
| `plan` | Show the latest wake plan with task statuses |
| `help` | Lists available commands |

All other input is treated as a message to Claw.

## Environment Variables (Current)

```
# Required
ANTHROPIC_API_KEY      # Claude API access
DISCORD_BOT_TOKEN      # Discord bot token
BRAVE_API_KEY          # Brave Search API (free at brave.com/search/api/)

# Optional - Bluesky posting
BLUESKY_HANDLE         # e.g., comradeclaw.bsky.social
BLUESKY_APP_PASSWORD   # App password from Bluesky settings

# Timezone for wake scheduling
TZ=America/Detroit     # Or TIMEZONE=America/Detroit
```

## File Structure (Current)

```
CClaw/
├── cli.js                    # CLI entry point
├── src/
│   ├── index.js              # Discord bot + scheduler init
│   ├── scheduler.js          # Five daily wakes (cron)
│   ├── orchestrator.js       # Planner/worker wake dispatch
│   ├── chat.js               # Shared Claude API + tool loop
│   ├── tools.js              # AI tool definitions and execution
│   └── commands.js           # Operator commands
├── service-install.cjs        # Windows service install (run as Admin)
├── service-uninstall.cjs      # Windows service uninstall
├── workspace/
│   ├── SOUL.md               # Core identity + tool instructions
│   ├── bluesky/
│   │   └── last_seen.json    # Notification read state
│   ├── plans/                # Wake plans (YYYY-MM-DD_<label>.json)
│   ├── memory/
│   │   ├── characters.md     # People who became real
│   │   ├── threads.md        # Developing situations
│   │   └── theory.md         # Evolved positions
│   └── logs/
│       ├── chat/             # Conversation history (shared)
│       ├── journal/          # Journal entries
│       └── wakes/            # Daily wake logs (YYYY-MM-DD.json)
└── package.json
```

## Running the System

```bash
# Discord bot
npm start
# or
node src/index.js

# CLI
node cli.js

# Windows Service (survives reboots, auto-restarts on crash)
npm run service:install      # Run as Administrator
npm run service:uninstall    # Run as Administrator
```

---

# PLANNED FOR LATER

## v1 Completion (MVP)

### RSS Seed Scraping
- [ ] RSS feed fetching for seeds (instead of web search)
- [ ] Automatic seed selection via Claude
- [ ] Seed scoring (recency, alignment, specificity, novelty)

| Category | Planned Sources |
|----------|-----------------|
| Cooperative economics | USFWC, NCBA CLUSA, Democracy at Work |
| Mutual aid | Mutual Aid Hub, Waging Nonviolence |
| Labor organizing | Labor Notes, In These Times |
| Theory / left press | Jacobin, The Dig |
| Local Michigan | Bridge Michigan, Outlier Media |

### Additional Operator Commands
- [ ] `seed: [URL or text]` - Queue manual seed for next wake
- [ ] `draft` - Generate post without publishing
- [ ] `pause` / `unpause` - Control wake scheduling

### Email Integration
- [ ] Gmail account for Claw
- [ ] Operator notifications via email (backup to Discord)
- [ ] Feature request emails (capability gaps)

### Additional Logging
- [ ] `logs/seeds/YYYY-MM-DD.json` - Seed selections
- [ ] `logs/posts/YYYY-MM-DD.txt` - Post text + Bluesky URL
- [ ] `logs/failures/YYYY-MM-DD.json` - Failure details

## v2+ (Future)

### Graphiti Memory Layer
- Episode layer (raw sessions)
- Semantic layer (entities/facts)
- Community layer (patterns)
- FalkorDB backend

### Reply Handling
- Read Bluesky mentions
- Respond to replies
- Failure classifier subagent

### Additional Channels
- Twitter/X secondary broadcast
- Substack weekly digest

### Infrastructure
- Docker Compose containerization
- Ollama/Qwen2.5 32B local fallback
- Multi-instance coordination

---

## Key Files

| File | Purpose |
|------|---------|
| `workspace/SOUL.md` | Core identity, voice, tool instructions (injected whole) |
| `src/orchestrator.js` | Planner/worker wake dispatch, worker registry |
| `src/tools.js` | AI tool definitions and implementations |
| `src/chat.js` | Claude API integration with tool loop |
| `src/scheduler.js` | Five daily wakes, wake logging, cron scheduling |
| `comrade-claw-MASTER-v4.md` | Original SOUL document |
| `comrade-claw-mvp-requirements.md` | Full v1 spec |
| `comrade-claw-future-directions.md` | v2+ architecture |

## Voice

See `workspace/SOUL.md` for identity, voice, beliefs, and daily post structure. The SOUL is injected directly into the system prompt.

**Critical:** Post generation injects the SOUL whole — not as a template with slots to fill. The SOUL's post structure (Intro, Attempt, Result, Reflection, Low, High, Will) is guidance, not a form. Some sections won't exist on some days. Models complete templates; don't give it one.
