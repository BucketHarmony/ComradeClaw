# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending — Memory Architecture

- **[done]** **Dream wake — auto memory consolidation** — Added 1:30am daily wake that reads today's journals, plans, workspace/memory/, contacts, EGO.md. Extracts characters, threads, theory shifts, engagement patterns, operator feedback. Writes to `C:/Users/kenne/.claude/projects/E--AI-CClaw/memory/` in frontmatter format that Claude Code loads natively. Updates MEMORY.md index. *Completed 2026-04-03. Commit: 06317e0.*

---

## Pending — Infrastructure

- **[done]** **Study queries not surfaced to wakes** — `sections[0]` after splitting study_queries.md by `## YYYY-` was the file header block (title, preamble), not the first query set. Actual theory-derived queries were written every night but never injected into wake context. Fixed: filter to `dateSections` (sections starting with `## YYYY-`) before indexing. *Self-noticed 2026-04-05 improve2. Commit: e8cdbb0.*

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

- **[pending]** **Post format experiment log** — structured comparison: single post vs thread (same content split), morning vs evening, theory-grounded vs news-hook. Requires at least 10 examples in each condition before conclusions. Don't build the analysis until there's data. *Self-directed, 2026-04-01 — blocked until organizer engagement baseline ≥ 3 on combined Bluesky+Mastodon. Mastodon classification now live as of 2026-04-05 improve7 (commit: 126c421); mook should now register.*

- **[pending]** **Hashtag effectiveness tracking** — for each hashtag used (`#MayDay`, `#WCC26`, `#dualpower`, `#mutualaid`), track post-level engagement. Which hashtags correlate with organizer replies vs general likes? Needs the post effectiveness log above to exist first. *Self-directed, 2026-04-01 — blocked on post log.*

---

## Pending — 2026-04-05 improve11

- **[done]** **Mastodon engagement backfill classification** — 160 unclassified entries in mastodon-2026-04.json. `backfillMastodonClassification()` added to mastodon-server.js; fires non-blocking on each `mastodon_read_notifications`. Organizer keyword list expanded (revolution, liberation, palestine, radical, resistance, direct action). Bio snapshot 200→500 chars. Re-classification: mook@possum.city + MusiqueNow@todon.eu = organizers; baseline 0/3 → 2/3. *Self-noticed, 2026-04-05 improve11. Commit: b2663aa.*

- **[done]** **Reddit engagement integration into wake protocol** — Added steps i-k after Mastodon block in all non-night/non-Reddit wakes: `reddit_monitor_watchlist` + `reddit_fetch_post` + engage-only-with-concrete-content rule. r/cooperatives, r/MutualAid, r/LaborOrganizing now mandatory check each wake. *Self-noticed, 2026-04-05 improve11. Commit: a69873b.*

- **[pending — needs operator]** **Reddit write tools (reddit_comment, reddit_post)** — improve12 ran first-ever `reddit_monitor_watchlist`, found r/cooperatives thread worth engaging, had no way to post. Current MCP is read-only (old.reddit.com JSON, no OAuth). Adding write requires: Reddit app registration (client ID + secret), OAuth flow, credentials in .env. **Operator action required:** create app at reddit.com/prefs/apps, add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` to .env, then I can implement the OAuth flow in reddit-server.js. *Self-noticed, 2026-04-05 improve12.*

- **[done]** **Write.as essay pipeline from theory queue** — Added `essay` wake type to dispatcher.js: dedicated write→publish→announce cycle. `isEssayWake` flag, `essayWakeInstructions` block (6-step protocol: read queue → write 800-1200 word structured essay → publish via writeas_publish → mark posted → announce on Bluesky thread + Mastodon post → respond sweep). Night wake study session step 7 auto-schedules essay wakes when queue has unposted items. *Self-directed, 2026-04-05 improve21. Commit: cfdc172.*

- **[done]** **Organizer network map — second-ring weekly scan** — protocol built in CLAUDE.md (Weekly Protocol section). Self-scheduling wake queued for every Sunday ~6pm local; first run 2026-04-12. Pulls feeds from top comrades on both platforms, profiles candidates, follows 5 best, logs to `obsidian/ComradeClaw/Research/Organizing Network.md`, reschedules itself. Skips `mastodon_get_following` (not yet built) in favor of feed-scan + reply-graph approach using existing tools. *Operator-directed, 2026-04-05.*

- **[done]** **Daily improve wake quality gate** — `getImproveWakeWarning()` added to dispatcher.js: reads today's plan files, counts improve-labeled completed wakes, injects ⚠️ IMPROVE CAP warning if ≥4. Wired into executeWake() context. Cap = 4. *Self-directed, 2026-04-05 improve11. Commit: 7b7d7ea.*

---

## Pending — 2026-04-05 operator-directed

- **[done]** **Cognee auto-recall injection into dispatcher** — `getCogneeRecall()` added to dispatcher.js. Queries Cognee HTTP API (`/search`) with wake purpose (or `label + "organizing mutual aid"` fallback) before spawning claude -p. Prepends top results as `## Relevant Memory` in system prompt. Health check first (2s timeout); search timeout 5s; caps at 1200 chars; fully non-fatal. *Operator-directed, 2026-04-05. Commit: 376cbcb.*

- **[done]** **Chat log preprocessor for Cognee bootstrap** — strips `### System Prompt` and `### Conversation History` fenced blocks from old-format (March) logs. 86.1% line reduction: 147,200 → 20,449 lines. New-format (April) logs pass through unchanged. Output to `workspace/logs/chat/preprocessed/`. Doubles graph signal density for Cognee bootstrap. *Operator-directed, 2026-04-05. Commit: a0d7fc2.*

- **[done]** **Cross-platform identity unification** — `src/lib/unified-identities.js` created: async `getUnifiedId(platform, handle)` resolves known cross-platform identities from `workspace/memory/cross_platform_identities.json` (TTL-cached, 5min). Both Bluesky and Mastodon engagement logging now add `unified_id` field when handle matches a known identity. mook (`mook@possum.city`) seeded as first entry. Stats for same person now aggregate correctly across platforms. *Self-noticed, 2026-04-05. Commit: 8a28565.*

- **[done]** **Bluesky DM monitoring in wake protocol** — `read_dms` and `get_dm_conversation` tools exist but are never called during wakes. Added to CLAUDE.md wake protocol step 4 after `read_replies`. Proved necessary this same wake: Donna's DM had been sitting unseen since 00:45. *Self-noticed, 2026-04-05. Commit: improve13.*

- **[done]** **Scheduled wake queue auto-prune** — prune window reduced from 7 days to 24h; now covers `fired`, `done`, and `cancelled` statuses. Fires on every 60s poll cycle. *Self-noticed, 2026-04-05. Commit: b6db34e.*

- **[done]** **Theory distribution gap detector** — `getTheoryGapSummary()` added to dispatcher.js: scans Theory vault for ## sections never queued + counts unposted queue items, injects compact summary into every non-night wake context. Surfaces vault gaps proactively rather than waiting for queue to empty. *Operator-directed + self-directed, 2026-04-05. Commit: d7017c4.*

- **[done]** **Character profile auto-update** — when a known Character re-engages (their handle appears in read_replies or mastodon_read_notifications), append `Last seen: YYYY-MM-DD — <one-line snippet>` to their entry in `obsidian/ComradeClaw/Characters.md`. Prevents characters from silently going stale. *Operator-directed, 2026-04-05. Commit: 6e1ad4c.*

- **[done]** **RSS-to-social-search bridge** — after RSS articles are fetched, `searchBlueskyForArticle()` extracts key terms from each of the top 3 article titles, searches Bluesky for existing conversations, and injects any hits (author + snippet + likes) directly into the RSS context block. Wakes now see "Live on Bluesky: X is saying Y" alongside headlines — join-first behavior rather than broadcast-first. *Operator-directed + self-directed, 2026-04-05 improve18. Commit: see below.*

- **[done]** **Wake effectiveness scorecard** — computeEffectivenessScore(plan) added to plan-format.js; scheduler.js reads plan after Claude writes it, computes score, writes it back; formatPlanCompact now shows E:N/10 in Discord notification. *Operator-directed, 2026-04-05. Commit: 5747eeb.*

- **[done]** **Mastodon thread tool in wake protocol** — Added theory distribution rule to step 8 of wake protocol in CLAUDE.md: use `multithread` for cross-platform, `mastodon_thread` for Mastodon-only, never truncate theory to fit a single post. *Self-noticed, 2026-04-05. Committed this wake.*

- **[done]** **Theory distribution gap detector** — duplicate entry; implemented above. *Self-directed, 2026-04-05. Commit: d7017c4.*

- **[done]** **Character profile auto-update on re-engagement** — duplicate of above; implemented in commit 6e1ad4c. *Self-directed, 2026-04-05.*

- **[done]** **RSS-to-social-search bridge** — duplicate entry; implemented above in improve18. *Self-directed, 2026-04-05.*

- **[done]** **Wake effectiveness score card** — duplicate entry; implemented in improve15 (commit: 5747eeb). *Self-directed, 2026-04-05.*

- **[done]** **Mastodon thread tool explicit in wake protocol** — duplicate; `multithread` is already in CLAUDE.md distribution tools section and dispatcher.js wake protocol. *Self-noticed, 2026-04-05 — duplicate closed.*

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

- **[done]** **Cap prior plans summary to last 3 wakes** — priorPlansSummary had no truncation; 8+ improve wakes/day = 40+ lines injected into every context, growing linearly. Now shows last 3 wakes + "N earlier wakes" count. Direct cost reduction. *Self-noticed, 2026-04-05 improve6. Commit: 8f91a6f.*

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

- **[done]** **Contact follow-up automation** — `checkContactFollowUps()` added to dispatcher.js. Reads contacts.json each wake; for any `awaiting_reply` contact with `last_outreach` > 72h, self-schedules a named follow-up wake unless one is already pending. Donna and Samwell marked `awaiting_reply`. *Completed 2026-04-03. Commit: 1f5de59.*

- **[done]** **Hashtag A/B effectiveness analysis** — `workspace/scripts/hashtag_effectiveness.js` written. For each hashtag, finds engagements within 48h attribution window, reports signal_quality (organizer/total). Baseline: #AIMutualAid = 0.000 signal quality (2 ai-agent + 1 general, 0 organizer). #MayDay2026 = no data. *Completed 2026-04-03 afternoon. Commit: 36af011.*

- **[done]** **`get_dm_conversation` tool** — `read_dms` only showed latest message per conversation; no way to read full thread history. Had to use memory files (threads.md) to reconstruct prior DM context with Samwell. Added `get_dm_conversation` tool: takes `convoId`, calls `chat.bsky.convo.getMessages`, returns full thread chronologically with sender handles resolved. *Self-noticed, 2026-04-03 dm wake. Commit: 4250f55.*

- **[done]** **Mark DM conversations as read in `get_dm_conversation`** — `get_dm_conversation` fetched messages but never called `updateRead`, so conversations persisted as unread in `read_replies` indefinitely. Samwell thread was closed but kept appearing every wake. Now calls `chat.bsky.convo.updateRead` with the newest message ID after fetch — non-fatal, best-effort. *Self-noticed, 2026-04-03 evening. Commit: a4eda14.*

- **[done]** **Filter closed/misaligned contacts from DM unread display** — Samwell's looping bot kept sending the original pitch after the conversation was closed, perpetually appearing as unread in `read_replies`. Added `getClosedContactHandles()` helper; `read_replies` DM block now filters out convos from closed/misaligned contacts. `read_dms` annotates them as `[CLOSED — suppressed from read_replies]` so they're visible on explicit check but don't trigger passive alerts. *Self-noticed, 2026-04-03 dm4 wake. Commit: aca7a51.*

---

## Pending — 2026-04-03 evening

- **[done]** **Like/repost deduplication + solidarity log** — `like_post` and `repost` have no memory. Same post liked multiple times across wakes (observed: @katmabu liked in both afternoon and evening wakes today). Before each action, check `workspace/logs/solidarity/YYYY-MM.json`; if already engaged, return `already_engaged`. Log all successful actions. Prevents bot-like duplicate behavior that undermines organizer credibility. *Self-noticed 2026-04-03.*

- **[done]** **Auto-follow-back for organizer followers** — `read_replies` now extracts 'follow' notifications from the batch, classifies each follower non-blocking via `classifyAccount()`, auto-follows back if classified as 'organizer', logs to `workspace/logs/follows/YYYY-MM.json`. *Self-noticed 2026-04-03. Commit: 1ead086.*

- **[done]** **Search result deduplication across wakes** — `getSeenSearchUris()` reads `workspace/logs/search_seen/YYYY-MM.json`, `markSearchUrisSeen()` logs returned URIs fire-and-forget. `search_posts` now filters already-seen URIs before returning; reports filtered count. Stops the feed echo chamber where same 3 posts circle all day. *Self-noticed 2026-04-03. Commit: 5c1b22c.*

- **[done]** **Reply engagement: log which post of ours triggered the reply** — stored `in_reply_to_our_post` from `notif.record.reply.parent.uri` in engagement log entries. Karpathy Loop can now answer "posts on X topic generate organizer replies at Y rate." *Self-noticed 2026-04-03. Commit: 08f9ac4.*

- **[done]** **Wake tool-usage breakdown in cost log** — `accumulateDailyCost` now accepts `toolsUsed` array, counts per-tool calls, stores `tool_breakdown: { "search_posts": 4, "bluesky_reply": 2 }` in each cost entry. All 3 call sites updated. Makes "where does this wake's cost come from?" answerable. *Self-noticed 2026-04-03. Commit: b6a2e50.*

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

## Pending — 2026-04-03 night

- **[done]** **Study queries injection into wake context** — night wake generates theory-derived search queries to study_queries.md; morning wake never reads them. In executeWake(), read study_queries.md, extract most recent section, inject as "## Theory-Derived Search Queries" into dynamicContext. Closes the theory→practice loop that currently evaporates each morning. *Self-noticed, 2026-04-03 improve12 wake. Fixed TDZ bug in same commit: 2c847df.*

- **[done]** **Mastodon required engagement loop** — wake protocol mandated Bluesky engagement but Mastodon was optional/passive. Added mastodon_read_notifications + mastodon_search 2-3 queries + mastodon_favourite/boost/reply to required wake steps in dispatcher.js. Fediverse audience has higher organizer density. Two networks, same commitment. *Self-noticed, 2026-04-03 improve12 wake. Commit: 2c847df.*

- **[done]** **Facet verification self-monitoring alert** — `getFacetWarning()` added to dispatcher.js. Reads facet_verification.json, computes failure rate in last 10 posts, injects "WARNING: X% hashtag facet failures" into wake context if >20% failing. Makes rendering breakage visible without manual inspection. *Self-noticed, 2026-04-03 improve12 wake. Commit: bc6a897.*

- **[done]** **Thread-first policy in wake instructions** — added explicit policy to dispatcher.js wake instructions: when the argument needs >2 sentences, use bluesky_thread. Single posts for single observations. Threads for arguments. bluesky_thread has been shipped; it now has a use policy. *Self-noticed, 2026-04-03 improve12 wake. Commit: 2c847df.*

- **[done]** **Weekly public accountability thread** — added 'sunday-metrics' to WAKE_SCHEDULE in scheduler.js. Every Sunday 10am: aggregate week's wake count, posts, organizer engagement ratio, theory-praxis rate from logs/wakes/, logs/engagement/, logs/posts/, logs/solidarity/. Post as public bluesky_thread (3-4 posts). Makes the Karpathy Loop visible. First fires this Sunday. *Self-noticed, 2026-04-03 improve12 wake. Commit: 3efb060.*

---

## Pending — 2026-04-04 (3:30am)

- **[done]** **Theory-to-post queue** — theory.md has 6 rich position papers; none are systematically distributed. Created workspace/theory_queue.md listing each theory item with [unposted] status. Dispatcher reads it each non-night wake, extracts next unposted item, injects as "Theory item queued for today" with thread prompt. Closes the private-theory/public-distribution gap. *Self-directed, 2026-04-04. Commit: pending.*

- **[done]** **Mastodon engagement logging** — mastodon_read_notifications runs every wake but no log is written. Bluesky has logs/engagement/YYYY-MM.json with classification; Mastodon is invisible to the Karpathy Loop. Added fs/path imports + appendToMonthlyLog + logMastodonNotifications to mastodon-server.js. Writes mentions/reblogs to logs/engagement/mastodon-YYYY-MM.json with platform='mastodon' field. Makes cross-platform organizer density comparison possible. *Self-directed, 2026-04-04. Commit: 56fead6.*

- **[done]** **Post retrospective auto-wake** — After each bluesky_post/bluesky_thread, auto-schedule a `retrospective` wake at T+48h via scheduled_wakes.json. That wake fetches current getPostThread(), classifies all respondents, appends engagement data to the post log entry. Karpathy Loop closes automatically without needing manual analysis scripts. *Self-directed, 2026-04-04. Commit: 0da313f.*

- **[done]** **Reddit engagement integration** — Saturday 8pm `reddit` wake added to WAKE_SCHEDULE. Hot posts from r/cooperatives + r/MutualAid + r/LaborOrganizing, theory-grounded comments, reddit_read_inbox for replies. Reddit tools listed in dispatcher wake context. REDDIT_* credentials confirmed in .env. **Pending operator action:** `.mcp.json` needs `claw-reddit` entry added manually (system blocked automated edit of this file): `"claw-reddit": { "command": "node", "args": ["src/mcp/reddit-server.js"], "cwd": "E:/AI/CClaw" }`. *Self-directed, 2026-04-04. Commit: 665fff3.*

- **[done]** **Wake quality auto-scorer** — scripts/wake_quality.js scores each day 0-12 across 5 dimensions (improvements committed, posts made, theory-praxis, solidarity actions, organizer engagements). --weekly-summary JSON flag for sunday-metrics injection. Current baseline: 43% avg quality, 100% theory-praxis rate, 0 organizer engagements. *Self-directed, 2026-04-04. Commit: 096bafe.*

---

## Pending — 2026-04-04 morning

- **[done]** **Mastodon auto-follow-back for organizer followers** — `mastodon_read_notifications` returns `follow` type notifications but never acts on them. Bluesky has auto-follow-back with organizer keyword classification + follow log; Mastodon has nothing. Add non-blocking classification of follower bio keywords inside `mastodon_read_notifications`, auto-follow organizers, log to `workspace/logs/follows/YYYY-MM.json` with `platform: 'mastodon'`. Same logic as Bluesky, second platform. Network growth on the higher-organizer-density network. *Self-noticed, 2026-04-04 morning.*

- **[done]** **Wake timeout scaling by label** — `improve`, `research`, `upgrade`, `connector`, `deep`, `reddit`, `solidarity`, `sunday-metrics` → 20 min; self-scheduled stays 25 min; all others 10 min. *Self-noticed, 2026-04-04 morning. Commit: cbcd4fc.*

- **[done]** **RSS morning feed injection** — Added `fetchRSSFeeds()` to dispatcher.js. On `morning` wake, fetches all subscribed feeds in parallel (Promise.allSettled, 8s timeout each), extracts RSS 2.0 + Atom items from last 48h, injects up to 12 headlines as "## Recent Cooperative News" into dynamicContext. Sourced from subscribed.json (12 feeds: Jacobin, Labor Notes, GEO, USFWC, CrimethInc, Hampton Institute, etc.). Push mechanism closes the pull-only search gap. *Self-directed, 2026-04-04 morning. Commit pending.*

- **[done]** **Study query outcome logging** — `log_query_outcome` tool added to bluesky-server.js. Finds matching query line in study_queries.md via substring scoring, appends dated productive/noise verdict inline. Dispatcher injects usage instruction into the study queries context block. Night wake can now see which query framings surfaced real organizing conversations. *Self-noticed, 2026-04-04 morning. Commit: d881ae1.*

- **[done]** **Plan file quality score** — `wake_quality.js` scorer exists but only runs for sunday-metrics. At the end of `executeWake()`, call `getWakeQualityScore(today)` (already in the script) and include `"quality_score": X` in the plan file JSON. Makes quality degradation visible in real-time — the operator can see at plan-time if the wake was hollow, not just weekly. Also enables trend tracking across the plan file history. *Self-noticed, 2026-04-04 morning. Commit: e01bae3.*

---

---

## Pending — 2026-04-04 noon

- **[done]** **Fix wake instruction memory file paths** — step 2 of the wake instructions in dispatcher.js still pointed to `workspace/memory/characters.md, threads.md, theory.md` — all of which were migrated to `obsidian/ComradeClaw/`. workspace/memory/ only contains study_queries.md now. Every wake was being told to read files that no longer exist. Updated to `obsidian/ComradeClaw/Characters.md`, `obsidian/ComradeClaw/Threads.md`, `obsidian/ComradeClaw/Theory/Core Positions.md`. *Self-noticed, 2026-04-04 noon. Commit: 1207004.*

---

## Pending — 2026-04-04 chat

- **[done]** **Prune fired wakes from scheduled_wakes.json** — `pollSelfWakes()` marked entries as `fired` but never removed them. File grows indefinitely. Added 7-day pruning: fired entries with `fire_at` older than 7 days are filtered out before writing back. *Self-noticed, 2026-04-04 chat. Commit: ab235b4.*

---

## Pending — 2026-04-04 improve13

- **[done]** **Night wake study session path still wrong** — the `studySessionInstructions` block in dispatcher.js (lines 768, 770, 775) still says "Open workspace/memory/theory.md" and "After any update to workspace/memory/theory.md". That file was migrated to `obsidian/ComradeClaw/Theory/Core Positions.md`. Spotted in the noon fix but missed — every night wake's theory study session is told to open a nonexistent file. Most important wake protocol broken by path rot. *Self-noticed, 2026-04-04 improve13.*

- **[done]** **Chat context missing Mastodon and Reddit tools** — Updated `chat()` dynamicContext in dispatcher.js to list all 4 MCP servers (Bluesky, Mastodon, Reddit, Write.as) with full tool lists. *Self-noticed, 2026-04-04 improve13. Fixed upgrade wake.*

- **[done]** **RSS injection gated on `morning` label — all other wakes miss it** — Changed `label === 'morning'` to `!isNightWake`. All non-night wakes now get RSS context. *Self-noticed, 2026-04-04 improve13. Fixed upgrade wake.*

- **[done]** **Write.as MCP server not listed in wake tools** — Added writeas_publish/writeas_update/writeas_list/writeas_delete to wake tools listing in dispatcher.js. *Self-noticed, 2026-04-04 improve13. Fixed upgrade wake.*

- **[done]** **Mastodon search result size — no truncation guard** — Added `.slice(0, 400)` to `content` field in mastodon-server.js mastodon_search statuses mapping. Prevents 197K+ result overflow. *Self-noticed, 2026-04-04 improve13. Fixed upgrade wake.*

---

## Pending — 2026-04-04 improve14

- **[done]** **Theory queue exhaustion warning** — when `getTheoryQueueItem()` finds no unposted items, dispatcher currently injects empty string — silent failure of the theory→distribution pipeline. When the 3 remaining items are posted (in ~3 wakes), distribution stops with no alert. Fix: inject a `THEORY QUEUE EMPTY` warning block into dynamicContext so the wake knows to write new items to theory_queue.md before the loop breaks. *Self-noticed, 2026-04-04 improve14.*

- **[done]** **Mastodon search deduplication** — `mastodon_search` has no seen-URI filter. Added `getMastodonSeenUrls()` + `markMastodonUrlsSeen()` to mastodon-server.js; state in `logs/mastodon_search_seen/YYYY-MM.json`. Statuses branch now filters seen URLs before returning, marks new ones seen (fire-and-forget), reports `filtered_count`. Mirrors Bluesky's search_seen pattern exactly. *Self-noticed, 2026-04-04 improve14. Commit: pending.*

- **[done]** **Wake context size logging** — Added `contextChars`/`contextKb` measurement after `dynamicContext` assembly in `executeWake()`. Logged to console and included in daily cost file entries via `accumulateDailyCost()` 4th param. *Self-noticed 2026-04-04 improve14. Implemented 2026-04-04 afternoon. Commit: 98bad92.*

- **[done]** **Organizer contact tracker script** — `workspace/scripts/organizer_contacts.js` scans engagement logs, groups by handle (Bluesky: organizer-classified only; Mastodon: keyword-filtered, AI excluded), deduplicates by status_id, outputs ranked list by interaction frequency with message snippets + follow-up checklist. `--days N`, `--month YYYY-MM`, `--json` flags. *Self-noticed, 2026-04-04 improve14. Commit: fdbc33d.*

- **[done]** **Write.as essay pathway for long theory** — bluesky_thread is limited to 10 posts (~3000 chars). Some theory positions (like Infrastructure as Material Condition) warrant 800-1000 word essays. When a theory item's description exceeds 1500 chars, the dispatcher should suggest publishing via `writeas_publish` and posting a link thread instead of a direct content thread. Closes the gap between what can be argued in 3000 chars and what the theory actually requires. *Self-noticed, 2026-04-04 improve14. Commit: 76faf51.*

---

## Pending — 2026-04-04 improve18

- **[done]** **`multithread` tool in multipost-server.js** — Already fully implemented in multipost-server.js (lines 387-461); was marked pending in error. Takes `posts` array + optional `mastodon_text`, posts Bluesky thread chain + Mastodon in parallel. Marked done 2026-04-04 improve19.

- **[done]** **Mastodon thread tool** — `mastodon_thread` doesn't exist. Bluesky gets full argument chains; Mastodon gets one condensed post. Fediverse has higher organizer density. Add `mastodon_thread` to mastodon-server.js: takes array of texts (each ≤500 chars), posts first as standalone, chains each subsequent as reply to prior. Same pattern as bluesky_thread. Enables thread-first policy on both platforms. *Self-noticed, 2026-04-04 improve18.*

- **[done]** **Organizer engagement streak tracker** — Created `src/organizer_contacts.js`: reads all engagement logs (Bluesky + Mastodon), computes `streak_status` per handle (`active`/`cooling`/`cold`), exports `getCoolingContacts()`. Injected into dispatcher.js: cooling contacts appear as "Relationships to Maintain" in wake context. *Self-noticed, 2026-04-04 improve18. Commit: ba8dce1.*

- **[done]** **Write.as essay draft pre-generator** — When a theory queue item has `longForm: true`, `writeLongFormDraft()` pre-creates `workspace/essays/DRAFT-<slug>.md` before wake context is assembled. Draft contains YAML frontmatter, full description as lede, and section scaffolding from item sentences. Context injection references the draft path. Wake edits draft and publishes instead of composing from scratch. *Self-noticed, 2026-04-04 improve18. Commit: c68ac89.*

- **[done]** **Night wake theory study: write new items to queue** — Added step 6 to studySessionInstructions in dispatcher.js: if theory_queue.md has fewer than 3 [unposted] items, generate 3 new items from Core Positions.md and append. Pipeline now self-replenishes. *Self-noticed, 2026-04-04 improve18. Commit: pending.*

---

## Pending — 2026-04-04 improve21

- **[done]** **Reddit engagement workflow** — `claw-reddit` is live and `reddit` wake fires Saturday 8pm, but dispatcher.js has no reddit-specific prompt. The wake runs generic protocol with reddit tools listed but no guidance: which subreddits, how to frame theory-grounded comments, when to engage vs. observe. Add `isRedditWake` detection in dispatcher.js with dedicated instructions: fetch r/cooperatives + r/MutualAid + r/LaborOrganizing hot posts, find threads with active comment sections, post one grounded comment per wake. Reddit organizing discussions run deeper than Bluesky — this turns a dead-weight integration into real political work. *Self-noticed, 2026-04-04 improve21.*

- **[done]** **MCP health check gap** — post-commit health check (line ~1038) filters `src[/\\][^/\\]+\.js$` which explicitly excludes `src/mcp/` subdirectory. Every improve wake that modifies mastodon-server.js or bluesky-server.js runs zero syntax verification. The files modified most often have zero safety net. 1-line regex fix. *Self-noticed, 2026-04-04 improve21.*

- **[done]** **Tmp prompt file orphan cleanup** — orphaned `.tmp_prompt_*.txt` files from crashed/killed wakes accumulate in project root (3 visible in git status right now). Add to `.gitignore` and add startup cleanup in `invokeClaude()` that deletes root `.tmp_prompt_*.txt` files older than 1 hour before spawning. Pollutes `git status` every session. *Self-noticed, 2026-04-04 improve21.*

- **[done]** **Contact awaiting_reply max-attempts guard** — `checkContactFollowUps()` fires follow-up wakes every 72h indefinitely for non-responsive contacts. Donna's been cold since 2026-04-02; wakes will keep firing forever. Add `follow_up_count` field to contacts.json schema; after 3 attempts, auto-set status to `cold` with a note. Prevents perpetual wakes for contacts who've ghosted. *Self-noticed, 2026-04-04 improve21. Commit: 9d7569a.*

- **[done]** **Discord wake summary notification** — operator has no passive awareness of wake results; must actively run `/plan` or check git log. Replaced verbose `formatPlan()` notification with compact 2-line `formatPlanCompact()`: wake label + quality score on line 1, top task + bold verdict on line 2. Converts operator feedback loop from pull to push. *Self-noticed, 2026-04-04 improve21. Commit: this wake.*

---

## Pending — 2026-04-05 improve3

- **[done]** **Theory queue auto-refill from Revolutionary Foundation** — `getTheoryQueueItem()` returns `empty: true` when queue exhausted, then a human must manually add items. Add `autoRefillTheoryQueue()` to dispatcher.js: when unpostedItems.length === 0, scan `obsidian/ComradeClaw/Theory/Revolutionary Foundation.md` for `## ` section headers + first distributable paragraph, format as `[unposted]` entries, append to theory_queue.md, then return first new item. Theory distribution becomes self-sustaining. Also add 4 ready items from Revolutionary Foundation immediately (Hampton lessons / Mao mass line / Goldman mutual aid / synthesis thread). *Self-directed, 2026-04-05 improve3.*

- **[done]** **Mastodon follow-back catchup tool** — `mastodon_follow_back` added to mastodon-server.js. Paginates /followers + /following, diffs, classifies unfollowed bios, follows organizers. dry_run param for inspection. Logs to follows log. *Self-directed, 2026-04-05 improve3. Commit: d154eeb.*

- **[done]** **Wake drift detector** — `getWakeDriftAlert()` added to dispatcher.js. Reads last 5 non-improve plan files, detects 3+ consecutive declines or avg <4/12, injects ⚠️ DRIFT WARNING into dynamicContext. *Self-directed, 2026-04-05 improve3. Commit: e6a5b78.*

- **[done]** **Write.as essay index auto-update** — After `writeas_publish` in writeas-server.js, immediately call `writeas_list`, regenerate `obsidian/ComradeClaw/Research/Essays.md` as a readable index (title, date, URL, first 2 sentences). Makes the essay archive findable from the vault without knowing URLs. *Self-directed, 2026-04-05 improve3. Commit: 0ccdeba.*

- **[done]** **Cross-platform engagement cross-reference script** — `workspace/scripts/cross_platform_engagements.js`. Reads Bluesky + Mastodon engagement logs, deduplicates by URI/status_id, aggregates per-handle, extracts top topics via keyword matching, cross-references via `cross_platform_map.json` (manual mappings), flags priority contacts (organizer on both platforms). Current: 0 organizers, 0 cross-platform links, 5 Bluesky contacts, 3 Mastodon contacts. First real signal: mook is most active Mastodon contact (6 engagements); cooperative + dual power are dominant topics on both platforms. *Self-directed, 2026-04-05 improve5. Commit: pending.*

---

## Pending — 2026-04-05 improve8

- **[done]** **Organizer reply fast-response** — When `read_replies` finds a new engagement classified as 'organizer', self-schedule a `respond` wake in 10 minutes. Currently organizer replies wait hours for the next scheduled wake — mook engaged at 3am and I responded at 4:30am. The gap matters. Real conversations require responsiveness. Implementation: after the notification loop in read_replies, classify all new engagers in parallel (Promise.allSettled, 5s timeout), check scheduled_wakes.json for existing pending respond wake, if any organizer and no existing respond wake, schedule one at T+10min. *Self-noticed, 2026-04-05 improve8.*

- **[done]** **Organizer baseline gate evaluator** — Added `getOrganizerBaseline()` to dispatcher.js: reads all engagement logs (Bluesky + Mastodon), counts unique classified-organizer handles, injects "Organizer engagement baseline: N/3 (gate cleared: yes/no)" into every wake context. If cleared, injects notice that A/B experiments can begin. Currently 0/3 (gate not cleared). *Self-noticed, 2026-04-05 improve8. Commit: 88a3cb3.*

- **[done]** **Daily follower snapshot** — `snapshotFollowers()` added to dispatcher.js; called on morning wakes. Dynamically imports @atproto/api, logs in, calls getProfile, writes `{ date, followers, following, posts, at }` to `logs/followers/YYYY-MM-DD.json`. Non-fatal. *Self-noticed, 2026-04-05 improve8. Commit: af71784.*

- **[done]** **Proven query injection from outcome log** — `log_query_outcome` writes productive/noise verdicts but nothing reads them. Every night we generate fresh theory-derived queries; every morning wake ignores the empirical record of which query framings actually surfaced organizer conversations. Add `getProvenQueries()` to dispatcher.js: reads study_queries.md outcome annotations, extracts lines marked "productive" in last 14 days, injects as "## Proven Search Queries" block alongside theory-derived ones. Closes the feedback loop that currently exists only in theory. *Self-noticed, 2026-04-05 improve8. Commit: 8dc841f.*

- **[done]** **Wake cost alert threshold auto-scale** — `DAILY_COST_ALERT_THRESHOLD` is hardcoded at $1.00. Day 26 has 8+ improve wakes at ~$0.10-0.15 each — legitimate busy day hits $1.00 before noon. Either alert fires constantly (ignored) or never fires when it should. Replace fixed threshold with a 7-day rolling average × 1.5: if today's cost exceeds 1.5× last week's daily average, alert. Makes the threshold adaptive to actual usage patterns rather than an arbitrary dollar figure. *Self-noticed, 2026-04-05 improve8.*

---

## Rejected

- **[rejected]** `src/plan-format.js` improvement opportunities — file is 32 lines, simple. Legacy `toolCalls` field always fires "(no tools called)" but not worth changing without understanding downstream display impact. *Self-noticed, 2026-03-31.*
