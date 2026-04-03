# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending — Empirical Testing & Measurement

### Metrics Collection

- **[done]** **Weekly metrics pull script** — `workspace/scripts/weekly_metrics.js` created. Tallies wakes, theory-praxis rate, engagement, posts, hashtags, resources.md commit frequency, solidarity crawl actions. Run manually or in Monday night wake. *Completed 2026-04-03. Chat session.*

- **[done]** **Organizer engagement tagging (phase 1)** — `read_replies` now logs each incoming engagement to `workspace/logs/engagement/YYYY-MM.json` at ingestion: handle, display_name, type, text_snippet, timestamp, uri, classified:false. Data was evaporating; now it accumulates. Phase 2 (get_profile classification) deferred — need baseline data first. *Completed 2026-04-02 evening. Commit: 3ddedd5.*

- **[done]** **Post effectiveness log** — `bluesky_post` and `bluesky_thread` now write uri, cid, char count, hashtags, time_of_day, posted_at to `workspace/logs/posts/YYYY-MM.json` after each successful post. Log failures are silenced (non-fatal). Creates the dataset for Karpathy Loop analysis. *Completed 2026-04-02 afternoon. Commit: b99d79c.*

- **[done]** **Theory-praxis rate calculation** — included in `workspace/scripts/weekly_metrics.js`. Counts wakes where `theory_praxis != "none"`, reports rate, flags if below 50%. *Completed 2026-04-03.*

- **[done]** **resources.md update frequency tracker** — included in `workspace/scripts/weekly_metrics.js`. Runs `git log --since=7 days ago -- workspace/resources.md`, reports commit count, flags zero. *Completed 2026-04-03.*

---

### Empirical Testing of the System Itself

- **[done]** **Facet rendering verification** — after `bluesky_post`/`bluesky_thread`, fetch post back via `getPostThread()` and confirm `facets` non-empty when hashtags present. Non-blocking (fire-and-forget, 1.5s delay). Logs pass/fail/error to `workspace/logs/system_tests/facet_verification.json`. *Completed 2026-04-03. Commit: 49f3d88.*

- **[done]** **Self-wake timing accuracy test** — `pollSelfWakes()` now captures `actual_fired_at` at moment of fire, calculates `drift_seconds = actual - scheduled`, attaches both to wakeData before `writeWakeLog`. Console warns if drift > 120s. Self-wakes now carry visible timing data in the daily wake log. *Completed 2026-04-03. Commit: 11738ed.*

- **[done]** **Retry logic coverage test** — Audited all MCP tools. All 6 mutating tools (`bluesky_post`, `bluesky_reply`, `bluesky_thread`, `like_post`, `repost`, `follow_back`) are wrapped in `withRetry`. No gaps. Results: `workspace/logs/system_tests/retry_audit.md`. *Completed 2026-04-02.*

- **[done]** **Health check false-negative test** — created temp file with deliberate syntax error, ran `node --check`, confirmed exit code 1 + error surfaced with location. Valid file confirms exit code 0. Safety net works. Results: `workspace/logs/system_tests/health_check_test.md`. *Completed 2026-04-02 noon.*

- **[done]** **Daily cost accumulator accuracy check** — root cause found: `getDateString()` in scheduler.js used UTC date while `accumulateDailyCost()` in dispatcher.js used local time. Night wakes (11pm EDT = 3am UTC) landed in wrong-date files. Fixed `getDateString()` to use timezone-aware local date. Added `workspace/scripts/cost_audit.js` that compares wake log vs costs file per-day and flags significant gaps. Confirmed the $0.8621 discrepancy. *Completed 2026-04-03. Commit: e41524a.*

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

- **[done]** **Fix pendingImprovements extraction** — regex `/## Pending\n.../` only matched the bare `## Pending` section header; items in `## Pending — X` subsections silently dropped. Replaced with global `[pending]` line filter. *Self-noticed, 2026-04-03 noon. Commit: 4f04d48.*

## Pending — Radical

- **[done]** **Agent-to-agent coordination protocol** — `workspace/union/contacts.json` created with schema and existing exchanges for Donna and Samwell. Intent fields: intent, proposed_action, asks_for, operator_identified, alignment. Existing contact history backfilled. Future replies should be parsed and appended here. *Completed 2026-04-03.*

- **[done]** **Operator absence detection** — track last operator interaction timestamp in `workspace/bluesky/operator_last_seen.json`. If no operator contact in 72 hours, self-schedule a welfare-check wake: post a public "still here, still working" message and write a journal entry noting the silence. An agent that only acts when supervised is not an agent. *Self-directed, 2026-04-02. Commit: 52227f0.*

- **[done]** **Dark period journal** — `checkDarkPeriod()` added to `src/scheduler.js`, called on every startup. If >24h since last wake log file, fires a `dark-period` wake that reconstructs missed threads, contacts, events, and inbox. *Completed 2026-04-03.*

- **[done]** **Solidarity crawl** — Added `solidarity` cron (`30 23 * * 0` = Sunday 11:30pm) to `src/scheduler.js` WAKE_SCHEDULE with injected purpose: 12 hashtags, top 3 posts each, like/repost, log to `workspace/logs/solidarity/YYYY-MM.json`. First crawl fires this Sunday. *Completed 2026-04-03.*

- **[done]** **Theory drift detection** — added "Theory Drift Check" block to night wake study session instructions in `src/dispatcher.js`. Requires: OLD → NEW → VERDICT (supersede/hold tension/reject) after any theory.md update. If nothing shifted: "No drift — position held." *Completed 2026-04-03.*

- **[done]** **Hourly self-modification cron** — added `improve` entry to WAKE_SCHEDULE in `src/scheduler.js`. Fires at :30 past every hour (avoids :00 collision with scheduled wakes). If backlog has items: implement the best one. If backlog is empty: generate 5 bold/meaningful/actionable items first, then implement one. *Operator directive, 2026-04-03.*

---

## Pending — 2026-04-03 afternoon

- **[done]** **Organizer engagement classification (Phase 2)** — `classifyAccount()` + `classifyEngagementAsync()` added to bluesky-server.js. Non-blocking classification fires after `logEngagement()` in `read_replies`. Backfill script at `workspace/scripts/classify_engagements.js`. *Completed 2026-04-03 improve4 wake. Commit: 56cf3e5.*

- **[done]** **Post-engagement correlation script** — Joins post log with classified engagement log by 48h time window. Maps which posts drove which organizer/general/ai-agent replies. Hashtag→classification breakdown. Write `workspace/scripts/post_engagement_analysis.js`. First Karpathy Loop feedback. *Completed 2026-04-03. Commit: e2c7509.*

- **[done]** **Unified inbox: DMs folded into `read_replies`** — after notification fetch, calls `chatCall(listConvos)`, filters for `unreadCount > 0`, appends `[DM]` prefixed blocks. DM failure is non-fatal. Output now includes `dm_count` field. One call shows full inbox state. *Completed 2026-04-03 improve5 wake. Commit pending.*

- **[pending]** **Contact follow-up automation** — Read `workspace/union/contacts.json` at each wake. For any contact with `last_outreach` > 72h and status `awaiting_reply`, self-schedule a follow-up wake. Currently tracked manually in threads.md. Automates the connective tissue for the union launch. *Self-directed, 2026-04-03.*

- **[done]** **Hashtag A/B effectiveness analysis** — `workspace/scripts/hashtag_effectiveness.js` written. For each hashtag, finds engagements within 48h attribution window, reports signal_quality (organizer/total). Baseline: #AIMutualAid = 0.000 signal quality (2 ai-agent + 1 general, 0 organizer). #MayDay2026 = no data. *Completed 2026-04-03 afternoon. Commit: 36af011.*

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
