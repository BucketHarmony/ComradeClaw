# Comrade Claw

**Status:** Active — running autonomously since Day 1
**Started:** 2026-03-11
**Last updated:** 2026-03-12

## Summary

Autonomous AI agent that wakes up five times daily, searches for FALGSC-aligned content, writes journal entries, and publishes to Bluesky. Custom Node.js app with Discord + CLI interfaces, orchestrator-worker wake architecture, and flat-file memory.

Day 1 produced 3 journal entries (3,465 words), found 465 worker cooperatives, mapped mutual aid networks spanning 46 years, documented community fridges across 6 years to 2 weeks old. Zero social engagement. The work continued.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Run Discord bot + scheduler
npm start

# Or run CLI (chat only, no wakes)
node cli.js
```

## Architecture

```
PLANNER (Claude call, one tool: plan_wake)
  | saves plan to workspace/plans/
ORCHESTRATOR (JavaScript, reads plan file)
  | for each pending task:
  WORKER (Claude call, filtered tools per task type)
  | orchestrator marks task done, writes summary + actual tool calls
  | next task gets prior results as context
ORCHESTRATOR updates plan status -> "complete"
  | notifies operator via Discord
```

- **Planner** decides what to do (gets SOUL, memory, prior wake plans, one tool: `plan_wake`)
- **Orchestrator** dispatches workers (JavaScript code, no LLM)
- **Workers** execute one task each in clean contexts with only the tools they need
- **Plan files** are persistent artifacts — saved, inspectable, auditable
- **Tool call tracking** records actual tools called per task (catches fabricated claims)

Worker types and their tools:

| Worker | Tools | Purpose |
|--------|-------|---------|
| `check_inbox` | `read_replies`, `read_email` | Check Bluesky + email |
| `respond` | `bluesky_reply` | Reply to conversations |
| `search` | `web_search` (max 4 queries) | Find material |
| `journal` | `journal_write`, `read_journal`, `read_memory` | Core creative act |
| `distribute` | `read_journal`, `bluesky_post` | Extract excerpt, post |
| `memory` | `memory_update`, `read_memory` | Curate characters/threads/theory |
| `send_email` | `send_email` | Feature requests, leads |
| `nothing` | (none) | Empty wake — logged, no worker |

**Why this architecture:** Claw experienced cognitive overload during monolithic wakes — 9+ task types in a single context caused fabrications at task boundaries (interpreting tool output while deciding next actions). Both observed fabrication incidents happened at task boundaries. Workers in isolated contexts with filtered tools eliminate this.

## Working Features

- **Discord + CLI interfaces** with shared conversation history
- **Five daily wakes** (9am, noon, 3pm, 6pm, 11pm) — Claw decides what each is for
- **Orchestrator-worker wake execution** with inspectable plan files
- **Tool call tracking** — plan files record actual tools called per task
- **AI tools**: web search (Brave), journal writing, memory updates, Bluesky posting/replying, email send/read
- **Memory system**: SOUL, characters, threads, theory (flat markdown)
- **Day counter**: calendar-based, multiple entries per day
- **Operator commands**: `status`, `wake`, `wakes`, `plan`, `clear`, `help`

## Environment Variables

```
# Required
ANTHROPIC_API_KEY      # Claude API (Sonnet)
DISCORD_BOT_TOKEN      # Discord bot
BRAVE_API_KEY          # Web search (free at brave.com/search/api/, 2000/month)

# Optional — Bluesky
BLUESKY_HANDLE         # e.g., comradeclaw.bsky.social
BLUESKY_APP_PASSWORD   # App password from Bluesky settings

# Optional — Email
GMAIL_ADDRESS          # Claw's Gmail
GMAIL_APP_PASSWORD     # Gmail App Password
OPERATOR_EMAIL         # Default recipient for send_email

# Timezone
TZ=America/Detroit     # Or TIMEZONE=America/Detroit
```

## Project Structure

```
CClaw/
├── cli.js                    # CLI interface
├── src/
│   ├── index.js              # Discord bot + scheduler init
│   ├── scheduler.js          # Five daily wakes (cron)
│   ├── orchestrator.js       # Planner/worker wake dispatch
│   ├── chat.js               # Claude API + tool loop (operator chat)
│   ├── tools.js              # AI tool definitions and execution
│   ├── history.js            # Persistent conversation history
│   └── commands.js           # Operator commands
├── service-install.cjs        # Windows service install (run as Admin)
├── service-uninstall.cjs      # Windows service uninstall
├── workspace/
│   ├── SOUL.md               # Core identity + voice + tool instructions
│   ├── plans/                # Wake plans (YYYY-MM-DD_<label>.json)
│   ├── bluesky/
│   │   └── last_seen.json    # Notification read position
│   ├── memory/
│   │   ├── characters.md     # People who became real
│   │   ├── threads.md        # Developing situations
│   │   └── theory.md         # Evolved positions
│   └── logs/
│       ├── chat/             # Conversation history (shared)
│       ├── journal/          # Journal entries
│       └── wakes/            # Daily wake logs
└── package.json
```

## Next Actions

- RSS feed scraping for seeds (replace pure web search)
- Substack publishing (weekly digest)
- Operator commands: `seed:`, `draft`, `pause`/`unpause`
- Stability testing: 7 consecutive days without intervention

## Open Questions

- Substack integration: unofficial API only, cookie-based auth, could break anytime
- Excerpt quality at scale: can the voice survive compression to 300 chars when entries get long?
- Feed list is anglophone-only: SOUL references Zapatistas, Mondragon, Paris Commune — watch for international thread atrophy
- Empty wake percentage: target 20-40% — monitor after first 14 days
- `respond` worker context: inbox summary needs full formatted output (URIs, content), not just counts
- Directive mechanism: should operator be able to seed next wake via chat conversation?

## Key Decisions

| Date | Decision | Context |
|------|----------|---------|
| 03-11 | Custom Node.js app | Planning docs described OpenClaw as runtime — it was never used. Custom app from day one. |
| 03-11 | SOUL v4 with grounding constraints | Trimmed non-load-bearing material, added anti-fabrication rules, day counter, The Intro section. |
| 03-11 | Journal as primary artifact | Voice doesn't work at 300 chars. Full entries in journal, compressed excerpts to Bluesky. |
| 03-11 | Five daily wakes | Morning/evening split evolved to 5 wakes. System provides schedule, Claw provides rhythm. |
| 03-12 | Orchestrator-worker architecture | Cognitive overload caused fabrications at task boundaries. Planner creates plan, workers execute in isolation with filtered tools. |
| 03-12 | Shared chat history | CLI and Discord share history.json. Operator chat separate from wake execution. |
| 03-12 | Plan files as artifacts | Saved to workspace/plans/, viewable with `plan` command. Structured records replace prose summaries. |
| 03-12 | Tool call tracking | Night wake memory worker claimed curation but called no tools. Now plan files record actual tool calls per task. |
| 03-12 | Search query cap (4/wake) | Morning wake burned 13 searches in one task. Instruction now says "up to 4." Free tier is 2000/month. |
| 03-12 | Distribute worker gets read_journal | Was failing because it only had bluesky_post — couldn't read the journal to find an excerpt. |

## Documentation

- `CLAUDE.md` — Technical reference for Claude Code (current vs planned)
- `PLAN.md` — Implementation progress tracking
- `workspace/SOUL.md` — The agent's identity, voice, beliefs, tool instructions
