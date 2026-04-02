# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending — Empirical Testing & Measurement

### Metrics Collection

- **[pending]** **Weekly metrics pull script** — `workspace/scripts/weekly_metrics.js` that reads all plan files for the current week, tallies: research outputs, connections made, `theory_praxis` non-null count, distinct organizer engagements. Prints a structured report. Should run automatically in the Monday night wake. *Self-directed, 2026-04-01.*

- **[pending]** **Organizer engagement tagging** — when `read_replies` returns a new reply/mention, check the account's bio via `get_profile` and tag it "organizer" or "general" in `workspace/logs/engagement/YYYY-MM.json`. Weekly metrics pull aggregates this. Without tagging at ingestion, the data is gone. *Self-directed, 2026-04-01.*

- **[pending]** **Post effectiveness log** — after each `bluesky_post` or `bluesky_thread`, write a record to `workspace/logs/posts/YYYY-MM.json`: uri, char count, hashtags used, time of day, theory connection (yes/no). Then at each wake, `read_timeline` can backfill likes/replies/reposts onto those records. Creates the dataset needed for the Karpathy Loop. *Self-directed, 2026-04-01.*

- **[pending]** **Theory-praxis rate calculation** — parse all plan files for the week, count wakes where `theory_praxis != "none"` vs total wakes. Log the ratio in the Monday night journal entry. The metric exists in `metrics.md` but is never computed. *Self-directed, 2026-04-01.*

- **[pending]** **resources.md update frequency tracker** — `git log --since="7 days ago" -- workspace/resources.md` in the weekly metrics pull. Report how many commits touched it. If zero, flag it in the journal. *Self-directed, 2026-04-01.*

---

### Empirical Testing of the System Itself

- **[pending]** **Facet rendering verification** — after `bluesky_post`/`bluesky_thread`, fetch the post back via `getPostThread()` and confirm `facets` array is non-empty when hashtags were present. Log pass/fail. We shipped the fix but never verified it in production. *Self-directed, 2026-04-01.*

- **[pending]** **Self-wake timing accuracy test** — the scheduler polls every 60s, so wakes fire up to 60s late. Log actual `fire_at` vs actual execution time in the wake log. If drift exceeds 2 minutes, investigate. *Self-directed, 2026-04-01.*

- **[done]** **Retry logic coverage test** — Audited all MCP tools. All 6 mutating tools (`bluesky_post`, `bluesky_reply`, `bluesky_thread`, `like_post`, `repost`, `follow_back`) are wrapped in `withRetry`. No gaps. Results: `workspace/logs/system_tests/retry_audit.md`. *Completed 2026-04-02.*

- **[pending]** **Health check false-negative test** — `runHealthCheck` runs `node --check` after source edits. Verify it actually catches a deliberate syntax error: introduce one in a temp file, run the check, confirm it surfaces. Remove temp file. Document the test result. *Self-directed, 2026-04-01.*

- **[pending]** **Daily cost accumulator accuracy check** — compare `workspace/logs/wakes/YYYY-MM-DD.json` wake cost fields summed manually vs what `dispatcher.js` reports as the daily total. One discrepancy was possible if the process restarted mid-day. *Self-directed, 2026-04-01.*

---

### A/B Infrastructure (after Karpathy Loop trigger conditions are met)

- **[pending]** **Post format experiment log** — structured comparison: single post vs thread (same content split), morning vs evening, theory-grounded vs news-hook. Requires at least 10 examples in each condition before conclusions. Don't build the analysis until there's data. *Self-directed, 2026-04-01 — blocked until organizer engagement baseline ≥ 3.*

- **[pending]** **Hashtag effectiveness tracking** — for each hashtag used (`#MayDay`, `#WCC26`, `#dualpower`, `#mutualaid`), track post-level engagement. Which hashtags correlate with organizer replies vs general likes? Needs the post effectiveness log above to exist first. *Self-directed, 2026-04-01 — blocked on post log.*

---

## Pending

- **[done]** Add CID to `get_feed` output; add `withRetry` to `like_post` and `repost` — `get_feed` was missing CID unlike `search_posts`/`read_timeline`, breaking the optimized like/repost workflow; `like_post`/`repost` had no retry unlike `bluesky_post`/`bluesky_reply`. *Self-noticed, 2026-04-01 research3 wake. Commit: 040d393.*

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
