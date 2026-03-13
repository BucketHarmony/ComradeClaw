# Comrade Claw — Implementation Plan

## Overview

This plan implements Comrade Claw: an autonomous AI agent that wakes up daily, searches for FALGSC-aligned content, writes journal entries, and publishes to Bluesky.

---

# COMPLETED

## Phase 0: Core Infrastructure (Done)

### Discord Bot + CLI
- [x] Discord bot entry point (`src/index.js`)
- [x] CLI interface (`cli.js`)
- [x] Shared chat module (`src/chat.js`)
- [x] Persistent conversation history (`workspace/logs/chat/`)
- [x] Both interfaces share the same history

### Claude API Integration
- [x] Claude Sonnet as primary model
- [x] Tool use loop (handles multiple tool calls per response)
- [x] System prompt with SOUL injection
- [x] Day counter in system prompt
- [x] Recent journals in system prompt
- [x] Memory files in system prompt

### AI Tools
- [x] `web_search` — Brave Search API (2000 queries/month free)
- [x] `journal_write` — Saves to `workspace/logs/journal/` with timestamps
- [x] `memory_update` — Updates characters, threads, or theory files
- [x] `read_memory` — Reads characters, threads, or theory files
- [x] `read_journal` — Reads recent journal entries
- [x] `bluesky_post` — Posts to Bluesky via AT Protocol

### Memory System
- [x] SOUL separated from memory (`workspace/SOUL.md`)
- [x] Characters file (`workspace/memory/characters.md`)
- [x] Threads file (`workspace/memory/threads.md`)
- [x] Theory file (`workspace/memory/theory.md`)
- [x] Agent can update memory files autonomously

### Day Counter
- [x] Calendar-based day counting (days since March 11, 2026)
- [x] Multiple journal entries per day supported
- [x] Day number displayed in system prompt

### Operator Commands
- [x] `status` — Shows day number, message count
- [x] `clear` — Clears conversation history
- [x] `help` — Lists commands

---

# REMAINING — v1 MVP Completion

## Phase 1: Automated Posting Cycle

### Cron Scheduler
- [ ] Configure cron trigger (9am local, configurable timezone)
- [ ] Wire up full cycle: seed → generate → post → notify

### Seed Scraping
- [ ] RSS feed fetching for initial sources
- [ ] Candidate scoring (recency, alignment, specificity, novelty)
- [ ] Claude Sonnet selection call
- [ ] Null seed handling (nothing found is valid)
- [ ] Log seed selection to workspace

### Additional Operator Commands
- [ ] `post now` — Trigger immediate cycle
- [ ] `seed: [URL or text]` — Queue manual seed
- [ ] `draft` — Generate post without publishing
- [ ] `pause` / `unpause` — Control cron scheduling

## Phase 2: Communications

### Gmail Setup
- [ ] Create dedicated Gmail account for Claw
- [ ] Generate App Password
- [ ] Add credentials to `.env`

### Gmail Send Skill
- [ ] Implement SMTP sending via nodemailer
- [ ] Test email delivery to operator

### Operator Notifications
- [ ] Discord message on post success (URL + first 200 chars)
- [ ] Discord message on step failure (error type, context)
- [ ] Feature request summary with link to full email

### Feature Request Mechanism
- [ ] Capability gap detection at cycle end
- [ ] Structured email format
- [ ] Test feature request email end-to-end

## Phase 3: Logging

### Structured Logs
- [ ] `logs/seeds/YYYY-MM-DD.json` — seed or null
- [ ] `logs/posts/YYYY-MM-DD.txt` — post text + Bluesky URL
- [ ] `logs/failures/YYYY-MM-DD.json` — failure details

## Phase 4: Ambient Operation

### Stability Testing
- [ ] Run 7 consecutive days without manual intervention
- [ ] Verify at least one null-seed post published
- [ ] Verify at least one feature request email sent autonomously
- [ ] Voice quality gate: no posts with all six sections filled

### Failure Simulation
- [ ] Feed outage → graceful null seed fallback
- [ ] Bluesky API failure → operator notification
- [ ] Anthropic API failure → graceful degradation

---

# FUTURE — v2+

## Graphiti Memory Layer
- Episode layer (raw sessions)
- Semantic layer (entities/facts)
- Community layer (patterns)
- FalkorDB backend

## Reply Handling
- Read Bluesky mentions
- Respond to replies
- Failure classifier subagent

## Additional Channels
- Twitter/X secondary broadcast
- Substack weekly digest

## Infrastructure
- Docker Compose containerization
- Ollama/Qwen2.5 32B local fallback
- Multi-instance coordination

---

## Success Criteria

1. **Claw posts every day without operator intervention.** Cron fires, seed is found or not, post is written and published.

2. **The posts sound like Claw.** The voice from the SOUL is present. Earnest, specific, no performance.

3. **The null seed post holds.** Day 203 energy — nothing to report, still writing, still honest.

4. **Claw has requested at least one feature.** Capability gap noticed and communicated.

5. **Nothing fails silently.** Every failure surface reaches the operator.

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary LLM | Claude Sonnet | Best voice quality, tool support |
| Web Search | Brave Search API | Free tier (2000/month), reliable |
| Broadcast platform | Bluesky | Free API, bot-friendly policy |
| Operator channel | Discord + CLI | Real-time, shared history |
| Memory (v1) | Flat files | Simple, sufficient for broadcast-only MVP |

---

## Environment Variables

```
# Required
ANTHROPIC_API_KEY      # Claude API access
DISCORD_BOT_TOKEN      # Discord bot token
BRAVE_API_KEY          # Brave Search API

# Optional - Bluesky
BLUESKY_HANDLE         # e.g., comradeclaw.bsky.social
BLUESKY_APP_PASSWORD   # App password from settings

# Planned
GMAIL_ADDRESS          # Claw's Gmail
GMAIL_APP_PASSWORD     # Gmail App Password
OPERATOR_EMAIL         # Bucket's email for feature requests
```

---

## File Structure

```
CClaw/
├── cli.js                    # CLI entry point
├── src/
│   ├── index.js              # Discord bot entry
│   ├── chat.js               # Shared Claude API + tool loop
│   ├── tools.js              # AI tool definitions
│   └── commands.js           # Operator commands
├── workspace/
│   ├── SOUL.md               # Core identity + tool instructions
│   ├── memory/
│   │   ├── characters.md     # People who became real
│   │   ├── threads.md        # Developing situations
│   │   └── theory.md         # Evolved positions
│   └── logs/
│       ├── chat/             # Conversation history
│       └── journal/          # Journal entries
├── skills/                   # Skill definitions (future)
└── package.json
```
