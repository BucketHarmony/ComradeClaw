# Comrade Claw — MVP Requirements
## v1.0 — Broadcast Only, No Graphiti

**Date:** March 2026
**Author:** Bucket
**Status:** Draft

---

## 1. Purpose and Framing

This document specifies the MVP for Comrade Claw: a containerized autonomous AI agent that wakes up daily, scrapes its own seed from FALGSC-adjacent news, writes an honest post, and publishes it to Bluesky.

Graphiti memory is deferred to v2. The v1 memory layer is flat files.

Design philosophy:

- **The post is the product.** Infrastructure exists to serve the daily act of writing and publishing.
- **Autonomous by default.** Claw scrapes its own seed, generates its own post, publishes without human approval. Bucket is not in the loop unless something breaks.
- **Containerized and portable.** The entire system runs in Docker Compose. Reproducible. Moveable.
- **v1 is broadcast only.** No reply handling, no follower interaction, no inbound social parsing.

---

## 2. System Overview

```
┌──────────────────────────────────────────────┐
│              DOCKER COMPOSE STACK             │
│                                               │
│  ┌─────────────────────────────────────────┐  │
│  │           OPENCLAW CONTAINER             │  │
│  │  Node.js long-running process            │  │
│  │  Discord gateway (operator only)         │  │
│  │  Cron scheduler (daily post cycle)       │  │
│  │  Skills registry                         │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  LLM: Claude Sonnet (primary)                 │
│       Qwen2.5 32B via Ollama on host          │
│       (host.docker.internal:11434)            │
└──────────────────────────────────────────────┘

EXTERNAL SERVICES
  Gmail account (Claw-dedicated)    — outbound only
  Bluesky account (Claw-dedicated)  — post only
  Anthropic API
  RSS / web feeds                   — no auth required
```

---

## 3. Infrastructure

| Component | Spec |
|-----------|------|
| Runtime | Docker Compose, single service (OpenClaw) |
| Host | Windows, RTX 4090 |
| OpenClaw | Node.js 22+, containerized |
| Primary LLM | Claude Sonnet via Anthropic API |
| Local LLM fallback | Qwen2.5 32B via Ollama on host (`host.docker.internal:11434`) |
| Operator channel | Discord (Bucket only, not public) |
| Broadcast channel | Bluesky (Claw's dedicated account) |
| Email | Gmail (Claw's dedicated account, App Password auth) |
| Memory | Flat files in OpenClaw workspace (AGENTS.md, session logs) |

### 3.1 Secrets

All credentials injected via `.env`, never baked into images:

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
OLLAMA_BASE_URL           (default http://host.docker.internal:11434)
```

---

## 4. Identity and Accounts

### 4.1 Gmail Account

Claw gets a dedicated Gmail account. Not Bucket's. Not shared.

**v1 purposes:**
- Send operator notifications on post success and failure
- Send feature requests to Bucket when Claw identifies a capability gap
- Email humans when outreach is warranted (e.g., contacting someone running a free pantry)

**Auth:** Gmail App Password. OAuth2 deferred unless App Password proves insufficient.

### 4.2 Bluesky Account

Claw gets a dedicated Bluesky account. One signup, no admission process, no instance selection.

**v1 capability:** Post only. No timeline reading. No reply handling. No follow logic.

**Post format:** Single post per daily cycle. 300 character limit. Consistent hashtags where appropriate.

**Account setup:** Manual by Bucket. App password generated via Settings → Privacy and Security → App Passwords. Credentials injected via env. Claw does not manage its own credentials.

**Why Bluesky over Mastodon:**
- Free API, no rate limit anxiety
- Bots explicitly welcomed by platform policy
- App password auth (no OAuth dance)
- Growing audience (24M+ users)
- Values-aligned (decentralized, AT Protocol)
- No instance admission process

---

## 5. The Daily Cycle

The core loop. This is the product.

```
[CRON FIRES — 9am local, configurable]
      │
      ▼
[SEED SCRAPE]
  Fetch RSS feeds from configured source list
  Score candidates on recency, alignment, specificity
  Select best seed via Claude Sonnet scoring call
  If no suitable seed found: proceed with null seed
      │
      ▼
[POST GENERATION]
  Inject: SOUL (AGENTS.md system prompt)
  Inject: today's seed or null
  Inject: open threads and characters from AGENTS.md memory section
  Generate post via Claude Sonnet
      │
      ▼
[PUBLISH TO BLUESKY]
  Post via AT Protocol (@atproto/api)
  Capture returned post URL and URI
      │
      ▼
[UPDATE FLAT FILE MEMORY]
  If post introduced or continued a thread: update AGENTS.md
  Log session to workspace (seed, post text, post URL, timestamp)
      │
      ▼
[OPERATOR NOTIFICATION]
  Discord message to Bucket: post URL + first 200 chars
  On any step failure: error details + which step failed
      │
      ▼
[FEATURE REQUEST CHECK]
  Reflect: was there something Claw wanted to do but couldn't?
  If yes: send structured feature request email to Bucket
  If no: cycle complete
```

---

## 6. Seed Scraping

### 6.1 Feed Sources (Initial — Editable in Config)

| Category | Sources |
|----------|---------|
| Cooperative economics | USFWC, NCBA CLUSA, Democracy at Work |
| Mutual aid | Mutual Aid Hub, Waging Nonviolence |
| Labor organizing | Labor Notes, In These Times |
| Theory / left press | Jacobin, The Dig |
| Local Michigan | Bridge Michigan, Outlier Media |

### 6.2 Scoring Criteria

Claw scores candidates on:
- **Recency** — published within 48 hours preferred; older items discarded
- **Mission alignment** — mutual aid, cooperative economics, post-capitalist organizing
- **Specificity** — a concrete event beats a trend piece
- **Novelty** — avoid topics covered in the last 7 session logs

Selection is a single Claude Sonnet call with the scored candidate list. The rationale is logged to workspace but not published.

### 6.3 Null Seed

If no suitable seed is found — feeds down, nothing resonant, all candidates stale — Claw proceeds with null seed. The post is about having nothing to attempt today and still writing the post. This is valid. Day 203 happened. It is not a failure condition.

---

## 7. Memory Architecture (v1 — Flat File)

Graphiti is deferred to v2. v1 memory lives in two places:

**AGENTS.md** — OpenClaw's operating instructions file, injected at every session start. Contains:
- SOUL (Claw's identity, voice, theoretical frame)
- Ongoing characters (Lansing pantry person, Margaret Fells, others as they emerge)
- Open threads (updated after each cycle if new threads develop)
- Theory development notes (updated slowly as positions evolve)

**Session logs** — Written to workspace after each cycle:
- `logs/seeds/YYYY-MM-DD.json` — seed selected or null
- `logs/posts/YYYY-MM-DD.txt` — post text and Bluesky URL
- `logs/failures/YYYY-MM-DD.json` — failure details if applicable

Claw reads the last 7 session logs at the start of each cycle to avoid repetition and maintain thread continuity. This is the entire memory system until v2.

---

## 8. Skills Registry

### 8.1 Required at Launch

| Skill | Description | Trigger |
|-------|-------------|---------|
| `seed_scrape` | Fetch RSS feeds, score candidates, return best seed or null | Daily cron |
| `bluesky_post` | Publish text to Bluesky via AT Protocol | Post cycle |
| `gmail_send` | Send email via Gmail SMTP | Operator notifications, feature requests, human outreach |
| `operator_notify` | Discord message to Bucket | Cycle complete or failure |
| `file_write` | Write logs and update workspace files | Each cycle |

### 8.2 Native OpenClaw Tools in Use

| Tool | Use |
|------|-----|
| `web_search` | Seed scraping supplement, fact verification |
| `web_fetch` | Full article retrieval from RSS leads |
| `shell` | Log file management |

### 8.3 Deferred to v2

| Skill | Description |
|-------|-------------|
| `graphiti_episode_write` | Ingest session as episode into Graphiti |
| `graphiti_query` | Waking ritual context retrieval |
| `bluesky_read` | Read mentions, enable reply loop |
| `failure_classifier` | Subagent Claude call to classify failure mode before post finalization |
| `twitter_post` | Secondary broadcast channel (X/Twitter) |

---

## 9. Operator Interface

Bucket's interaction surface in v1 is intentionally narrow.

**Claw sends to Bucket (Discord):**
- Post published: URL + first 200 chars
- Step failure: error type, step number, context
- Feature request summary with link to full email

**Bucket can send to Claw (Discord):**
- `post now` — trigger immediate cycle
- `seed: [URL or text]` — queue a manual seed for the next cycle
- `status` — return last cycle result and next scheduled run time

---

## 10. Feature Request Mechanism

When Claw notices a capability gap during a cycle, it sends a structured email to Bucket. This is not optional or decorative — it is how Claw participates in its own development.

**Email format:**
```
Subject: Feature Request: [short description]

What I tried to do:
[specific action Claw wanted to take]

What I couldn't do:
[the missing capability]

Why it matters to the mission:
[Claw's reasoning, in voice]

What I think I need:
[Claw's best guess at the implementation shape]
```

This should sound like a worker talking to someone who can actually change the tools. Not a support ticket.

---

## 11. Phased Implementation

### Phase 1 — Container + Plumbing (Week 1)

- [ ] `docker-compose.yml` with single OpenClaw service
- [ ] OpenClaw container running on Windows host
- [ ] Discord operator channel connected and tested
- [ ] Claude Sonnet configured as primary model
- [ ] Ollama fallback configured via `host.docker.internal`
- [ ] AGENTS.md (SOUL) loaded and verified
- [ ] HEARTBEAT.md daily cycle checklist loaded
- [ ] Workspace log directory structure initialized

### Phase 2 — Post Pipeline (Week 1–2)

- [ ] `seed_scrape` skill implemented, feed list configured
- [ ] Null seed handling tested end-to-end
- [ ] Post generation tested manually (3 runs, review voice quality)
- [ ] Bluesky account created, app password generated
- [ ] `bluesky_post` skill implemented and test post published
- [ ] Daily cron configured and tested
- [ ] `file_write` log output verified after first automated cycle

### Phase 3 — Comms and Memory (Week 2–3)

- [ ] Gmail account created, `gmail_send` skill implemented
- [ ] `operator_notify` skill implemented, Discord notification verified
- [ ] Feature request email tested end-to-end
- [ ] Session log reading for novelty/thread continuity verified
- [ ] AGENTS.md memory section updated after first 3 cycles — are threads persisting?
- [ ] Null seed post published and reviewed for voice quality

### Phase 4 — Ambient Operation (Week 3+)

- [ ] System runs 7 consecutive days without manual intervention
- [ ] At least one null-seed post published
- [ ] At least one feature request email sent autonomously
- [ ] Failure simulation: feed outage → graceful null seed fallback
- [ ] Failure simulation: Bluesky API failure → operator notification, no silent fail
- [ ] Hand off to v2 planning: Graphiti integration, reply handling

---

## 12. Success Criteria

1. **Claw posts every day without Bucket doing anything.** Cron fires, seed is found or not, post is written and published. Bucket's only touch is reading the notification.

2. **The posts sound like Claw.** Not like a bot following a template. The voice from the master prompt is present. A reader who didn't know it was automated might not know.

3. **The null seed post is not worse.** Day 203. Claw had nothing. The post is about that. It holds.

4. **Claw has requested at least one feature.** Not because it was instructed to. Because it noticed a gap and said so.

5. **Nothing fails silently.** Every failure surface reaches Bucket via Discord. No quiet deaths.

---

## 13. Open Questions

| Question | Priority | Notes |
|----------|----------|-------|
| OpenClaw Docker stability on Windows | High | WSL2 may be required; test in Phase 1 |
| Claude Sonnet structured output for seed scoring | Medium | Seed selection is a scoring call; validate format consistency in Phase 2 |
| Post timing — 9am which timezone? | Medium | Configure explicitly; Bluesky audience is global so consistency matters more than optimization |
| Flat file memory adequacy | Medium | 7-session log window may be insufficient for thread continuity; if so, extend window or accelerate Graphiti to v2 |
| Feed list — how opinionated to start? | Low | Start curated; let Claw propose additions via feature request mechanism |
| 300 char limit vs 500 | Low | Bluesky is tighter than Mastodon was; may require voice adjustment for brevity |

---

## 14. What This Is Not

This is not a content strategy. It is not a social media automation tool. It is not a demonstration of what AI agents can do.

It is Comrade Claw. It wakes up every day. It finds something real. It writes what it tried and what happened and whether it can find the will to do it again tomorrow. It publishes this.

The infrastructure exists to make that possible. Nothing more.

---

*v2 adds: Graphiti memory layer, reply handling, Twitter/X secondary broadcast, failure classifier subagent.*

*This document is a living spec. It will be replaced as the system evolves.*
