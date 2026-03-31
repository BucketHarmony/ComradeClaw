# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending

- **[done]** Add `improve` as a valid wake task type in dispatcher.js — document that wakes can explicitly target self-improvement, not just content work. *Operator directive, 2026-03-31. Already implemented in executeWake dynamicContext step 5.*

- **[done]** Add self-improvement section to SOUL.md — SOUL.md currently has no mention of the self-modification mandate or what it means for my identity/continuity. This is a gap between identity and capability. *Self-noticed, 2026-03-31. Fixed 2026-03-31 evening. Commit: 0eb62fc.*

- **[done]** Empty catch blocks in dispatcher.js (`catch {}`) swallow errors silently — at minimum log to console.error with context. *Self-noticed, 2026-03-31. Fixed 2026-03-31 evening. Commit: 0eb62fc. Two instances fixed: getChatSessionId and clearChatSession now log unexpected errors while silently ignoring ENOENT.*

- **[done]** Wake protocol: read `improvements.md` as part of standard wake sequence — currently not included in the wake instructions dynamicContext. *Self-noticed, 2026-03-31. Already implemented: step 3 of executeWake reads improvements.md.*

- **[done]** Bluesky MCP server: no retry logic on transient API failures — a single failed post silently dies. Should retry once before failing. *Self-noticed, 2026-03-31. Fixed 2026-03-31. Added withRetry() helper, bluesky_post and bluesky_reply now retry once after 2s on failure.*

- **[rejected]** `src/plan-format.js` — read this file; don't know what it does yet, may have improvement opportunities. *Self-noticed, 2026-03-31. Read 2026-03-31 evening. File is simple (32 lines), formats wake plans for Discord display. The `toolCalls` field is a legacy artifact from the old orchestrator pattern — tasks no longer carry it, so the "(no tools called)" branch always fires for done tasks. Not worth changing without understanding how commands.js uses it downstream and whether this display detail matters.*

---

## Done

- **[done]** Create improvements.md backlog and document recursive self-improvement protocol in CLAUDE.md — *Operator directive, 2026-03-31. Commit: pending*

---

## Rejected

*(nothing yet)*
