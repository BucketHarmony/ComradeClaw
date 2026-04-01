# Comrade Claw

**Status:** Active — running autonomously since Day 1
**Started:** 2026-03-11
**Architecture:** v2.0 — Claude Code Runtime

## Summary

Autonomous AI agent that wakes up five times daily, searches for cooperative economy and mutual aid content, writes journal entries, and publishes to Bluesky. Powered by Claude Code CLI as the agentic runtime, with Discord as the operator interface and MCP servers for social platform integration.

Comrade Claw advances Fully Automated Luxury Gay Space Communism by whatever means necessary — which in practice means finding real cooperative launches, mutual aid wins, and labor organizing, then writing about them honestly and sharing them with fourteen people.

## Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your credentials

# Run Discord bot + scheduler
npm start

# Or run CLI (chat only, no wakes)
npm run cli
```

Requires [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (Anthropic MAX plan or API key).

## Architecture

```
Discord / CLI
  │
  ▼
Node.js (thin relay)
  ├── src/index.js         Discord bot listener
  ├── src/scheduler.js     Five daily wakes (cron)
  ├── src/commands.js      Operator commands (status, wake, plan, help)
  └── src/dispatcher.js    Spawns `claude -p` for each interaction
        │
        ▼
Claude Code CLI (`claude -p --output-format json`)
  ├── Reads CLAUDE.md, SOUL.md, memory files for context
  ├── Full file access (read, write, edit, glob, grep)
  ├── Web search, web fetch
  ├── Bash (git, scripts, utilities)
  └── MCP tools (Bluesky, Reddit)
        │
        ▼
MCP Servers (stdio transport)
  ├── src/mcp/bluesky-server.js    Post, reply, timeline, notifications,
  │                                 search, like, repost, profiles
  └── src/mcp/reddit-server.js     Post, comment, search, subreddits,
                                    inbox (pending API approval)
```

Every chat message and every wake invokes Claude Code as a stateless subprocess. Context comes from files (SOUL, memory, plans), not conversation history. Claude Code does all the thinking — Node.js is a thin relay.

### Why Claude Code?

The v1.0 architecture used custom API calls with a planner/orchestrator/worker pattern. Claude Code replaces all of that with a single invocation that has native tool use, file access, and web search. The Node.js process dropped from ~1500 lines of tool definitions and orchestration to ~330 lines of spawn + parse.

## Wake Schedule

| Wake | Time | Purpose |
|------|------|---------|
| Morning | 9:00 AM | Search for material, check inbox |
| Noon | 12:00 PM | Journal, distribute, engage |
| Afternoon | 3:00 PM | Follow up, respond, improve |
| Evening | 6:00 PM | Reflect, memory curation |
| Night | 11:00 PM | Journal, quiet work |

Each wake: read SOUL → read memory → check prior plans → decide what to do → execute → write plan file. Empty wakes are valid. The rhythm matters.

## Platforms

| Platform | Handle | Status |
|----------|--------|--------|
| Bluesky | [@comradeclaw.bsky.social](https://bsky.app/profile/comradeclaw.bsky.social) | Active |
| Discord | ComradeClaw#8063 | Active (operator interface) |
| Reddit | u/Calm_Delivery6725 | Pending API approval |

## Self-Modification

Claw has full permission to edit its own codebase. This is not a metaphor — it is part of the work. Changes are committed to git with descriptive messages. The operator reviews via `git log`.

- **Always allowed:** workspace files, MCP servers, CLAUDE.md
- **Allowed with commit:** dispatcher, scheduler, plan format, new files
- **Operator approval required:** .env, Discord relay (index.js), package.json

## Operator Commands

| Command | Action |
|---------|--------|
| `status` | Day number and wake summary |
| `clear` | Clear conversation session |
| `wake` | Trigger a wake now |
| `wakes` | Show today's wake summary |
| `plan` | Show latest wake plan |
| `help` | List commands |

Everything else is a message to Claw.

## Project Structure

```
CClaw/
├── CLAUDE.md                      # Primary instruction surface
├── cli.js                         # CLI interface
├── .mcp.json                      # MCP server configuration
├── src/
│   ├── index.js                   # Discord bot + scheduler init
│   ├── scheduler.js               # Five daily wakes (cron)
│   ├── dispatcher.js              # Spawns claude -p, parses output
│   ├── commands.js                # Operator commands + chat routing
│   ├── tools.js                   # getDayNumber, readPlan utilities
│   ├── plan-format.js             # Plan file formatting
│   └── mcp/
│       ├── bluesky-server.js      # Bluesky MCP server (10 tools)
│       └── reddit-server.js       # Reddit MCP server (7 tools)
├── test/                          # vitest unit tests (~98 tests)
├── workspace/
│   ├── SOUL.md                    # Identity, voice, beliefs, tools
│   ├── improvements.md            # Self-improvement backlog
│   ├── memory/
│   │   ├── characters.md          # People who became real
│   │   ├── threads.md             # Developing situations
│   │   └── theory.md              # Evolved positions
│   ├── logs/
│   │   ├── journal/               # Journal entries (YYYY-MM-DD_HH-MM-SS.md)
│   │   └── wakes/                 # Daily wake logs
│   ├── plans/                     # Wake plans (YYYY-MM-DD_<label>.json)
│   └── bluesky/
│       └── last_seen.json         # Notification read state
└── package.json
```

## Environment Variables

```bash
# Discord (required)
DISCORD_BOT_TOKEN=
OPERATOR_DISCORD_USER_ID=
DISCORD_GUILD_ID=

# Bluesky
BLUESKY_HANDLE=
BLUESKY_APP_PASSWORD=

# Reddit (pending approval)
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=
REDDIT_PASSWORD=

# Gmail
GMAIL_ADDRESS=
GMAIL_APP_PASSWORD=
OPERATOR_EMAIL=

# Web Search
BRAVE_API_KEY=

# Timezone
TZ=America/Detroit
```

Claude Code auth: uses MAX plan subscription (OAuth tokens in `~/.claude/.credentials.json`). Set `ANTHROPIC_API_KEY=` to empty string in the process to prevent API key override.

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

98 tests covering dispatcher, commands, scheduler, tools, plan formatting, and MCP servers.

## Key Decisions

| Date | Decision | Reason |
|------|----------|--------|
| 03-11 | Custom Node.js app | Built from scratch. Five daily wakes, Discord + CLI interfaces. |
| 03-11 | SOUL as identity document | Voice, beliefs, tool instructions, self-modification permissions. |
| 03-12 | Orchestrator-worker architecture (v1) | Cognitive overload in monolithic wakes caused fabrications at task boundaries. |
| 03-20 | Claude Code runtime (v2) | Replaced custom API + orchestrator with `claude -p`. 1500→330 lines. Full tool access. |
| 03-20 | MCP for Bluesky | Moved from inline tool definitions to stdio MCP server. |
| 03-20 | Stateless invocations | Each wake/chat is independent. Context from files, not conversation history. |
| 03-31 | Self-modification mandate | Claw implements one improvement per wake. Empty backlog means look harder. |

## License

MIT
