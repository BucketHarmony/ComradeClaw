# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending

- **[done]** Remove phantom follower counts from `search_accounts` output — `searchActors` API never returns `followersCount`/`followsCount`, so output always showed `Followers: ? | Following: ?`. Misleading noise. Removed the line. *Self-noticed, 2026-04-01 connector wake. Commit: 14e38f6.*

- **[done]** Add RichText facets to `bluesky_post`, `bluesky_reply`, `bluesky_thread` — hashtags and @mentions were posting as plain text, invisible to Bluesky hashtag search. Real impact on discoverability. *Self-noticed, 2026-04-01. Commit: a7a0138.*

- **[done]** Replace dynamic imports in `runHealthCheck` with static — `execFile` and `promisify` were re-imported on every health check call. Moved to static imports at module level with `execFileAsync` defined once. *Self-noticed, 2026-04-01. Commit: ea4596f.*

- **[done]** Deduplicate plan filenames when same wake label runs twice in a day — second research wake was clobbering first's plan. Now generates research2.json, research3.json etc. *Self-noticed, 2026-04-01. Commit: 3a88507.*

- **[done]** Add `since` date filter to `search_posts` MCP tool — Bluesky API supports `since`/`until` ISO params but tool didn't expose them. Searched "May Day 2026" all morning and got 2025 results. Real friction. *Self-noticed, 2026-04-01.*

- **[done]** Fix timezone bug in `executeWake` — UTC dates for plan file paths/names broke night wakes (11pm EDT = 3am UTC = wrong date). Now uses `toLocaleDateString('en-CA', { timeZone: tz })` consistently. *Self-noticed, 2026-04-01. Commit: c84c18b.*

- **[done]** Add `bluesky_thread` tool to MCP server — chain up to 10 posts, root + reply chain. *Self-scheduled, implemented early 2026-04-01. Commit: e2fe7e2.*
- **[done]** Define Layer 1 metrics before building Karpathy Loop — what does "better" mean? Written to `workspace/memory/metrics.md`. *Operator directive, 2026-04-01.*

- **[done]** Add daily study session to night wake — dedicated to reading theory, writing what shifts, generating tomorrow's search queries. Operator directive 2026-03-31.
- **[done]** Add `bold_check` and `theory_praxis` accountability fields to plan file format — every wake must account for boldness and theory-praxis connection. Operator directive 2026-03-31.
- **[done]** Make Bluesky engagement mandatory in every wake — like, repost, reply required; search_posts/like_post/repost added to wake tool list. *Operator directive + self-noticed, 2026-03-31. Commit: 2001f60.*
- **[done]** Chat memory lost between sessions — each invocation was stateless with no history injection. Now loads last 30 turns from daily log files and injects into system prompt. *Operator-reported, 2026-03-31. Commit: 7b96928.*
- **[done]** Wake dynamic context doesn't inline the improvements.md content — Claude has to do a separate Read call. Could inline the pending section directly to save a tool call each wake. *Self-noticed, 2026-03-31. Commit: 5076d3e.*
- **[done]** Robot kombucha drift (Days 18-20): wakes produced off-mission content with no mechanism to detect or correct. Need a mission-check step: before posting, does this post advance FALGSC? If no, don't post it. Add to wake prompt. *Self-noticed, 2026-03-31. Commit: 978251f.*
- **[done]** No validation that the plan file was actually written before `executeWake` returns — silent failure if Claude forgets to write it. Added console.warn when planFile is null. *Self-noticed, 2026-03-31. Commit: 9053d37.*
- **[done]** `bluesky_reply` in the MCP server doesn't validate that `replyTo` is a valid AT URI before sending — bad input produces a confusing upstream error. Add a quick format check. *Self-noticed, 2026-03-31. Commit: b6aa1f6.*
- **[done]** Wake cost logging uses `$${result.cost.toFixed(4)}` — would be more useful to accumulate and log daily total alongside per-wake cost. *Self-noticed, 2026-03-31. Commit: 214b6e3.*
- **[done]** `read_replies` filters to new-only by default using `last_seen.json`, but there's no tool to manually reset that cursor if it gets stuck. Added `reset_last_seen` tool to MCP server. *Self-noticed, 2026-03-31. Commit: e669f3f.*
- **[done]** Self-wake queue — write `workspace/scheduled_wakes.json` with a JSON entry to schedule a future wake at any interval. Scheduler polls every 60s and fires when due. Persists across restarts. *Operator directive, 2026-04-01.*
- **[done]** Post-commit health check — after a wake modifies src/*.js, run `node --check` on each file and log syntax errors before they kill the next wake. *Self-noticed, 2026-04-01.*

---

## Done

- **[done]** Create improvements.md backlog and document recursive self-improvement protocol in CLAUDE.md — *Operator directive, 2026-03-31.*
- **[done]** Add self-improvement section to SOUL.md — gap between identity and capability. *Self-noticed, 2026-03-31. Commit: 0eb62fc.*
- **[done]** Empty catch blocks in dispatcher.js swallow errors silently — log unexpected errors, ignore ENOENT. *Self-noticed, 2026-03-31. Commit: 0eb62fc.*
- **[done]** Wire improvements.md into wake dynamicContext (step 3). *Self-noticed, 2026-03-31. Already implemented.*
- **[done]** Add `improve` as valid wake task type (step 5 of executeWake). *Operator directive, 2026-03-31. Already implemented.*
- **[done]** Remove chat session persistence — context comes from files, not session IDs. *Self-noticed, 2026-03-31. Commit: 8432f33.*
- **[done]** Bluesky MCP: no retry on transient failures. Added withRetry() to bluesky_post and bluesky_reply. *Self-noticed, 2026-03-31. Commit: faa7a07.*
- **[done]** Remove dead session helper functions (getChatSessionId, saveChatSessionId, SESSION_FILE) from dispatcher.js — orphaned when session persistence was removed in 8432f33. Simplify clearChatSession to no-op. *Self-noticed, 2026-03-31.*
- **[done]** Fix spawn path separators in dispatcher.js — use forward slashes for shell:false on Windows, add explicit shell:false. *Self-noticed, 2026-03-31.*

---

## Rejected

- **[rejected]** `src/plan-format.js` improvement opportunities — file is 32 lines, simple. Legacy `toolCalls` field always fires "(no tools called)" but not worth changing without understanding downstream display impact. *Self-noticed, 2026-03-31.*
