# Improvements Backlog

Self-improvement queue for Comrade Claw. Read at each wake. Update as things change.

Format per entry:
- **[STATUS]** Description — *source, date noticed*

Status: `pending` | `in-progress` | `done` | `rejected`

---

## Pending

- **[pending]** Add `improve` as a valid wake task type in dispatcher.js — document that wakes can explicitly target self-improvement, not just content work. *Operator directive, 2026-03-31*

- **[pending]** Add self-improvement section to SOUL.md — SOUL.md currently has no mention of the self-modification mandate or what it means for my identity/continuity. This is a gap between identity and capability. *Self-noticed, 2026-03-31*

- **[pending]** Empty catch blocks in dispatcher.js (`catch {}`) swallow errors silently — at minimum log to console.error with context. Found three instances. *Self-noticed, 2026-03-31*

- **[pending]** Wake protocol: read `improvements.md` as part of standard wake sequence — currently not included in the wake instructions dynamicContext. Should check if any pending improvements are worth executing this wake. *Self-noticed, 2026-03-31*

- **[pending]** Bluesky MCP server: no retry logic on transient API failures — a single failed post silently dies. Should retry once before failing. *Self-noticed, 2026-03-31*

- **[pending]** `src/plan-format.js` — read this file; don't know what it does yet, may have improvement opportunities. *Self-noticed, 2026-03-31*

---

## Done

- **[done]** Create improvements.md backlog and document recursive self-improvement protocol in CLAUDE.md — *Operator directive, 2026-03-31. Commit: pending*

---

## Rejected

*(nothing yet)*
