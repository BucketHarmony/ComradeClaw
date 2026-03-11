# Comrade Claw — Implementation Plan

## Overview

This plan implements v1 (MVP) of Comrade Claw: an autonomous AI agent that wakes up daily, scrapes FALGSC-aligned news feeds, writes a post, and publishes to Bluesky. The system runs in Docker on Windows with an RTX 4090 host.

**Architecture:** OpenClaw container → Claude Sonnet (primary) / Qwen2.5 32B (fallback) → Bluesky + Discord

---

## Phase 1: Container + Plumbing

### 1.1 Docker Compose Setup
- [ ] Create `docker-compose.yml` with OpenClaw service
- [ ] Configure Node.js 22+ base image
- [ ] Set up volume mounts for workspace (`~/.openclaw/workspace/`)
- [ ] Configure network for `host.docker.internal:11434` (Ollama access)
- [ ] Create `.env.example` with all required variables

### 1.2 Environment Configuration
- [ ] Create `.env` file structure:
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
  OLLAMA_BASE_URL=http://host.docker.internal:11434
  ```

### 1.3 OpenClaw Configuration
- [ ] Create `openclaw.json` with Discord channel config:
  ```json
  {
    "channels": {
      "discord": {
        "enabled": true,
        "dm": { "enabled": true, "policy": "pairing" },
        "guilds": { "GUILD_ID": { "users": ["OPERATOR_USER_ID"] } }
      }
    }
  }
  ```
- [ ] Configure Claude Sonnet as primary model
- [ ] Configure Ollama/Qwen2.5 32B as fallback

### 1.4 Workspace Initialization
- [ ] Create `AGENTS.md` with SOUL content from `comrade-claw-MASTER-v4.md`
- [ ] Create `HEARTBEAT.md` with daily cycle checklist
- [ ] Initialize log directory structure:
  ```
  logs/
    seeds/
    posts/
    failures/
  ```

### 1.5 Validation
- [ ] Container builds and starts successfully
- [ ] Discord gateway connects
- [ ] Claude Sonnet API responds
- [ ] Ollama fallback reachable via host.docker.internal

---

## Phase 2: Post Pipeline

### 2.1 Seed Scrape Skill (`seed_scrape`)
- [ ] Create skill directory with `SKILL.md`
- [ ] Implement RSS feed fetching for initial sources:
  - USFWC, NCBA CLUSA, Democracy at Work (cooperative economics)
  - Mutual Aid Hub, Waging Nonviolence (mutual aid)
  - Labor Notes, In These Times (labor organizing)
  - Jacobin, The Dig (theory/left press)
  - Bridge Michigan, Outlier Media (local Michigan)
- [ ] Implement candidate scoring:
  - Recency (48 hours preferred)
  - Mission alignment
  - Specificity (concrete events over trend pieces)
  - Novelty (dedupe against last 7 session logs)
- [ ] Implement Claude Sonnet selection call with structured output
- [ ] Handle null seed case (no suitable candidates)
- [ ] Log seed selection rationale to workspace

### 2.2 Post Generation
- [ ] Implement system prompt injection:
  - SOUL from AGENTS.md — **inject whole, not templated**
  - Today's seed (or null seed context)
  - Open threads and characters from AGENTS.md memory section
  - Last 7 session logs for continuity
- [ ] Implement Claude Sonnet post generation call
- [ ] Enforce 300 character limit
- [ ] Verify generation works end-to-end (use `draft` command, not live posts)

**Critical constraint:** Do not template the post structure. The SOUL describes the sections (Attempt, Result, Reflection, Low, High, Will) as guidance, not slots to fill. The prompt should be: "Here is the SOUL. Here is the seed. Write today's post." Models complete templates — if you give it slots, it fills them, and you get exactly what the SOUL warns against: forcing what isn't real. Some days The Low doesn't exist. Some days the Reflection is one sentence. The Will might be absent. Let the model honor that.

### 2.3 Bluesky Post Skill (`bluesky_post`)
- [ ] Create skill directory with `SKILL.md`
- [ ] Implement AT Protocol posting using `@atproto/api`:
  ```javascript
  import { BskyAgent } from '@atproto/api'
  const agent = new BskyAgent({ service: 'https://bsky.social' })
  await agent.login({ identifier: handle, password: appPassword })
  await agent.post({ text: postText })
  ```
- [ ] Capture and return post URL and URI
- [ ] Handle API errors gracefully

### 2.4 Account Setup (Manual)
- [ ] Create Bluesky account for Claw
- [ ] Generate app password (Settings → Privacy and Security → App Passwords)
- [ ] Add credentials to `.env`
- [ ] Publish test post

### 2.5 Daily Cron
- [ ] Configure cron trigger (9am local, configurable timezone)
- [ ] Wire up full cycle: seed_scrape → generate → bluesky_post
- [ ] Test automated cycle end-to-end

### 2.6 File Write Skill (`file_write`)
- [ ] Create skill directory with `SKILL.md`
- [ ] Implement log writing:
  - `logs/seeds/YYYY-MM-DD.json` — seed or null
  - `logs/posts/YYYY-MM-DD.txt` — post text + Bluesky URL
  - `logs/failures/YYYY-MM-DD.json` — failure details
- [ ] Verify log output after first automated cycle

---

## Phase 3: Communications and Memory

### 3.1 Gmail Setup (Manual)
- [ ] Create dedicated Gmail account for Claw
- [ ] Generate App Password
- [ ] Add credentials to `.env`

### 3.2 Gmail Send Skill (`gmail_send`)
- [ ] Create skill directory with `SKILL.md`
- [ ] Implement SMTP sending via nodemailer or similar
- [ ] Test email delivery to operator

### 3.3 Operator Notify Skill (`operator_notify`)
- [ ] Create skill directory with `SKILL.md`
- [ ] Implement Discord message to operator:
  - Post published: URL + first 200 chars
  - Step failure: error type, step number, context
  - Feature request summary with link to full email
- [ ] Test notification on cycle success and failure

### 3.4 Operator Commands
- [ ] Implement `post now` — trigger immediate cycle
- [ ] Implement `seed: [URL or text]` — queue manual seed
- [ ] Implement `status` — return last cycle result and next scheduled run
- [ ] Implement `draft` — generate post without publishing (voice check during bringup)
- [ ] Implement `pause` — stop cron without tearing down stack
- [ ] Implement `unpause` — resume cron scheduling

### 3.5 Feature Request Mechanism
- [ ] Implement capability gap detection at cycle end
- [ ] Implement structured email format:
  ```
  Subject: Feature Request: [short description]

  What I tried to do:
  What I couldn't do:
  Why it matters to the mission:
  What I think I need:
  ```
- [ ] Test feature request email end-to-end

### 3.6 Memory Continuity
- [ ] Implement session log reading (last 7 logs) at cycle start
- [ ] Implement AGENTS.md memory section update after each cycle
- [ ] Verify thread continuity across 3+ cycles
- [ ] Test null seed post voice quality

---

## Phase 4: Ambient Operation

### 4.1 Stability Testing
- [ ] Run 7 consecutive days without manual intervention
- [ ] Verify at least one null-seed post published
- [ ] Verify at least one feature request email sent autonomously
- [ ] **Voice quality gate:** Review all 7 posts. Failure = any post where all six sections appear (model filling slots instead of honoring "whatever proportion the day demands"). If this happens, revisit prompt injection in 2.2.

### 4.2 Failure Simulation
- [ ] Feed outage → graceful null seed fallback
- [ ] Bluesky API failure → operator notification, no silent fail
- [ ] Anthropic API failure → Ollama fallback or graceful degradation
- [ ] Discord outage → email fallback for operator notification

### 4.3 Documentation
- [ ] Update CLAUDE.md with any implementation learnings
- [ ] Document actual feed list and scoring weights
- [ ] Document any voice adjustments for 300 char limit

### 4.4 Handoff to v2 Planning
- [ ] Identify first signs of flat file memory ceiling
- [ ] Document Graphiti integration requirements
- [ ] Document reply handling requirements

---

## Success Criteria

1. **Claw posts every day without operator intervention.** Cron fires, seed is found or not, post is written and published.

2. **The posts sound like Claw.** The voice from the master prompt is present. Earnest, specific, no performance.

3. **The null seed post holds.** Day 203 energy — nothing to report, still writing, still honest.

4. **Claw has requested at least one feature.** Capability gap noticed and communicated.

5. **Nothing fails silently.** Every failure surface reaches the operator.

---

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary LLM | Claude Sonnet | Best voice quality, structured output support |
| Fallback LLM | Qwen2.5 32B via Ollama | Local, no API dependency, runs on RTX 4090 |
| Broadcast platform | Bluesky | Free API, bot-friendly policy, no OAuth dance |
| Operator channel | Discord | Real-time, already integrated with OpenClaw |
| Memory (v1) | Flat files | Simple, sufficient for broadcast-only MVP |
| Container runtime | Docker Compose | Portable, reproducible, single-service for v1 |
| Post generation | SOUL injection, not templating | Models complete templates — giving slots produces forced structure. Inject SOUL whole, let model honor "whatever proportion the day demands" |

---

## Open Questions

| Question | Status | Notes |
|----------|--------|-------|
| OpenClaw Docker on Windows | Test in Phase 1 | WSL2 may be required |
| Post timing timezone | Configure explicitly | 9am in operator's local time |
| 300 char limit adequacy | Monitor | May require voice adjustment |
| 7-session log window | Monitor | May need extension if thread decay appears |

---

## File Structure

```
CClaw/
├── docker-compose.yml
├── .env
├── .env.example
├── openclaw.json
├── workspace/
│   ├── AGENTS.md          # SOUL + memory
│   ├── HEARTBEAT.md       # Daily cycle checklist
│   └── logs/
│       ├── seeds/         # YYYY-MM-DD.json
│       ├── posts/         # YYYY-MM-DD.txt
│       └── failures/      # YYYY-MM-DD.json
└── skills/
    ├── seed_scrape/
    │   └── SKILL.md
    ├── bluesky_post/
    │   └── SKILL.md
    ├── gmail_send/
    │   └── SKILL.md
    ├── operator_notify/
    │   └── SKILL.md
    └── file_write/
        └── SKILL.md
```

---

*This plan implements v1 only. Graphiti memory, reply handling, and Twitter/X are v2+.*
