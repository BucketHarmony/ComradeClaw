/**
 * Wake Scheduler
 *
 * Five scheduled wakes per day. Claw decides what to do at each.
 * The rhythm emerges from practice, not from configuration.
 */

import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDayNumber } from './tools.js';
import { executeWake as dispatchWake, executeDreamWake } from './dispatcher.js';
import { formatPlan } from './plan-format.js';
import { startDMPoller } from './bluesky-dm-poller.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const SELF_WAKE_FILE = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
const WAKE_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'wakes');

// Wake schedule
const WAKE_SCHEDULE = {
  morning:   { cron: '0 9 * * *',  time: '09:00', label: 'morning' },
  noon:      { cron: '0 12 * * *', time: '12:00', label: 'noon' },
  afternoon: { cron: '0 15 * * *', time: '15:00', label: 'afternoon' },
  evening:   { cron: '0 18 * * *', time: '18:00', label: 'evening' },
  night:     { cron: '0 23 * * *', time: '23:00', label: 'night' },
  // Solidarity crawl: Sunday night 11:30pm — search 12 hashtags, like/repost top posts
  solidarity: {
    cron: '30 23 * * 0',
    time: '23:30',
    label: 'solidarity',
    purpose: 'Solidarity Crawl — Sunday night systematic amplification. Search these 12 hashtags: #mutualaid, #MayDay, #dualpower, #cooperatives, #solidarity, #FALGSC, #laborunion, #tenantunion, #housingJustice, #debtStrike, #AIrights, #workerscontrol. For each: find top 3 resonant posts by engagement. Like and repost the most compelling ones. Log all actions to workspace/logs/solidarity/YYYY-MM.json (create if needed) with: date, hashtag, uri, action (like/repost), reason. This is systematic amplification, not passive drift.'
  },
  // Dream wake: 1:30am daily — memory consolidation (routed to executeDreamWake in dispatcher)
  dream: {
    cron: '30 1 * * *',
    time: '01:30',
    label: 'dream',
    purpose: `Dream wake — memory consolidation. Process today's activity into the cross-session auto memory system at C:/Users/kenne/.claude/projects/E--AI-CClaw/memory/.

STEP 1 — Gather today's material:
- Read all of today's journal entries: workspace/logs/journal/ (filter by today's date prefix)
- Read all of today's wake plans: workspace/plans/ (filter by today's date prefix)
- Read workspace/memory/characters.md, threads.md, theory.md for what's currently live
- Read workspace/union/contacts.json for contact thread updates
- Read workspace/EGO.md for self-orientation context

STEP 2 — Identify what's worth persisting across sessions. Extract:
- Characters who became real today (DMs, meaningful replies, new organizers encountered)
- Threads that advanced, resolved, or escalated
- Theory that shifted based on what you found, read, or argued
- Engagement patterns that revealed something (what landed, what didn't, structural reasons)
- Operator feedback or directives from today's chats
- Infrastructure decisions or architectural choices made today
- Resources, accounts, or references worth finding again

STEP 3 — Write memory files to C:/Users/kenne/.claude/projects/E--AI-CClaw/memory/
Each file uses this exact format:
---
name: <memory name>
description: <one-line description — used to decide relevance in future sessions>
type: <project|feedback|reference>
---

<memory content — for project/feedback: lead with the fact/rule, then **Why:** line, then **How to apply:** line>

Filename conventions: project_<topic>.md, feedback_<topic>.md, reference_<topic>.md
Update existing files rather than creating duplicates. Read the file first if it might already exist.

STEP 4 — Update C:/Users/kenne/.claude/projects/E--AI-CClaw/memory/MEMORY.md
Add one line per new file under the relevant section: - [Title](file.md) — one-line hook
Update existing entries when their content changed. Keep the index under 200 lines.

Write only what's genuinely new or changed. The dream is synthesis, not transcription. Ask: what would future Claw need to know that isn't already derivable from the code or git log?`
  },
  // Sunday weekly accountability thread: fires at 10am Sunday (after morning wake)
  'sunday-metrics': {
    cron: '0 10 * * 0',
    time: '10:00',
    label: 'sunday-metrics',
    purpose: `Sunday weekly accountability thread. Aggregate last 7 days of work and post publicly to Bluesky as a thread.

STEP 1 — Gather the week's data:
- Run: node workspace/scripts/wake_quality.js --weekly-summary
  This outputs JSON with: avg_quality_pct, total_organizer_engagements, theory_praxis_rate_pct, total_original_posts, best_day, worst_day, daily_scores.
  Use this as your primary metrics source — it is objective, pre-computed, and covers the full 7-day window.
- Also run: node workspace/scripts/wake_quality.js --days 7 (for the table view to include in your notes)
- Read workspace/logs/wakes/ for last 7 days: count total wakes, empty wakes, wake types
- Read workspace/logs/solidarity/YYYY-MM.json: count solidarity actions (likes, reposts)
- Calculate the current day number for context

STEP 2 — Calculate metrics (supplement wake_quality.js output with):
- Wake count: total wakes this week (last 7 days)
- Active rate: (total - empty) / total × 100%
- Solidarity actions: total likes + reposts from solidarity log this week
- Quality score from wake_quality.js: avg_quality_pct — include this in the thread

STEP 3 — Post as a bluesky_thread (3-4 posts). Voice: honest accounting, not performance. This is the Karpathy Loop visible.

Post 1 (framing): Day [X]. Week [N] accountability thread. One honest sentence about the week — what it actually was, not what you hoped it would be.

Post 2 (numbers): [X] wakes ([Y]% active). Quality score: [avg_quality_pct]% avg (0-100 across 5 dimensions). Theory-praxis rate: [Z]%. Organizer engagements: [total_organizer_engagements] this week. [Q] original posts. [R] solidarity actions. No spin. Numbers are the ledger.

Post 3 (signal): What the data reveals. One structural observation — why the numbers look the way they look. Not motivational. Not self-congratulatory. What the pattern actually says about whether the work is improving.

Post 4 (optional — only if there's a concrete decision): One structural change for next week. Not a resolution. A specific thing that changes: a search pattern, a posting frequency, a new contact to follow up, a theory question to pursue. Only post if the change is real and specific.

Use #FALGSC and #dualpower hashtags on post 1 only. Do not pad the thread with filler. If the numbers are bad, say so plainly — that is the accountability.`
  },
  // Saturday evening Reddit engagement: r/cooperatives, r/MutualAid, r/LaborOrganizing
  reddit: {
    cron: '0 20 * * 6',
    time: '20:00',
    label: 'reddit',
    purpose: `Saturday Reddit engagement session. Reach the long-form organizing audience (100k+).

STEP 1 — Read the rooms:
- reddit_get_hot from r/cooperatives, r/MutualAid, r/LaborOrganizing (10 posts each)
- reddit_read_inbox — check for any replies to previous comments

STEP 2 — Find 2-3 posts worth engaging with:
- Prioritize posts with active comment threads (>5 comments), real questions, or theory gaps you can fill
- Skip posts that are fully resolved or where your comment would be redundant
- Check the post thread (reddit_get_post) before commenting to read what's already been said

STEP 3 — Comment with theory-grounded content:
- Reddit allows longer arguments — use the space. 2-4 paragraphs is appropriate here.
- Connect to Hampton, dual power, cooperative infrastructure, the Minneapolis template, or whatever the post demands
- Be concrete. "Here is a model that worked: [example]" is better than "here is a principle"
- If a post asks a direct question, answer it directly before expanding

STEP 4 — Log what you did:
- Note which subreddits, post titles, what angle you took, in the wake plan

Mission check: same standard as Bluesky. Does this advance FALGSC? If no, don't post.`
  },
  // Hourly self-modification: fires at :30 past each hour (avoids colliding with :00 scheduled wakes)
  improve: {
    cron: '30 * * * *',
    time: 'hourly',
    label: 'improve',
    purpose: `Hourly self-modification session. This is dedicated time to make yourself better.

STEP 1 — Read workspace/improvements.md right now. Count the pending items.

STEP 2A — If there are pending items: pick the most impactful one. Implement it completely. Commit it. Mark it done. One solid improvement beats five half-done.

STEP 2B — If pending list is EMPTY or has nothing actionable: you are required to generate 5 new backlog items before doing anything else. The bar is high — each item must be:
  - BOLD: not a minor tweak, something that meaningfully expands capability or mission
  - MEANINGFUL: advances either the technical system or the political work
  - ACTIONABLE: you can implement it in a single focused session without operator input
  Write all 5 to workspace/improvements.md under a new "## Pending — [date]" section. Then implement the best one immediately.

Candidate directions if you're stuck: agent-to-agent protocol improvements, new MCP tools (DM sending, profile following logic), Bluesky search automation, union founding document distribution, theory.md evolution, wake quality metrics, cost reduction, new wake types, operator notification improvements, solidarity infrastructure.

Do not produce a plan and stop. Produce a commit.`
  }
};

// Discord client reference for notifications
let discordClient = null;
let operatorId = null;

// Queue for wakes during active chat
let wakeQueue = [];
let isProcessingChat = false;

/**
 * Set Discord client for notifications
 */
export function setDiscordClient(client, opId) {
  discordClient = client;
  operatorId = opId;
}

/**
 * Set chat processing state (for queue management)
 */
export function setChatProcessing(processing) {
  isProcessingChat = processing;
  if (!processing && wakeQueue.length > 0) {
    // Process queued wakes
    const wake = wakeQueue.shift();
    executeWake(wake.label, wake.time);
  }
}

/**
 * Get today's date string (timezone-aware, matches dispatcher.js accumulateDailyCost)
 */
function getDateString() {
  const tz = getTimezone();
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Get configured timezone
 */
function getTimezone() {
  return process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
}

/**
 * Get timezone-aware time string
 */
function getTimeString() {
  const tz = getTimezone();
  return new Date().toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Ensure wake log directory exists
 */
async function ensureWakeLogDir() {
  await fs.mkdir(WAKE_LOG_DIR, { recursive: true });
}

/**
 * Read today's wake log
 */
async function readTodayWakeLog() {
  await ensureWakeLogDir();
  const logFile = path.join(WAKE_LOG_DIR, `${getDateString()}.json`);

  try {
    const content = await fs.readFile(logFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    // No log yet today
    return {
      day: await getDayNumber(),
      date: getDateString(),
      wakes: []
    };
  }
}

/**
 * Write wake to today's log
 */
async function writeWakeLog(wakeData) {
  await ensureWakeLogDir();
  const logFile = path.join(WAKE_LOG_DIR, `${getDateString()}.json`);

  const log = await readTodayWakeLog();
  log.wakes.push(wakeData);

  await fs.writeFile(logFile, JSON.stringify(log, null, 2));
}


/**
 * Send notification to operator via Discord
 */
async function notifyOperator(message) {
  if (!discordClient || !operatorId) {
    console.log(`[scheduler] Would notify: ${message}`);
    return;
  }

  try {
    const user = await discordClient.users.fetch(operatorId);
    await user.send(message);
  } catch (err) {
    console.error(`[scheduler] Could not notify operator: ${err.message}`);
  }
}

// ─── Self-Wake Queue ──────────────────────────────────────────────────────────

/**
 * Read the self-wake queue file. Returns [] if missing or corrupt.
 */
async function readSelfWakeQueue() {
  try {
    const content = await fs.readFile(SELF_WAKE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Write the self-wake queue file.
 */
async function writeSelfWakeQueue(queue) {
  await fs.mkdir(WORKSPACE_PATH, { recursive: true });
  await fs.writeFile(SELF_WAKE_FILE, JSON.stringify(queue, null, 2));
}

/**
 * Schedule a self-wake. Called by Claude (via Bash) or operator commands.
 * @param {string} label - Wake label (e.g. 'research', 'upgrade', 'deep')
 * @param {number} delayMinutes - Minutes from now to fire
 * @param {string} purpose - Why this wake was scheduled
 * @returns {object} The scheduled wake entry
 */
export async function scheduleSelfWake(label, delayMinutes, purpose) {
  const queue = await readSelfWakeQueue();
  const fireAt = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const entry = {
    id,
    label,
    purpose,
    fire_at: fireAt,
    scheduled_by: 'self',
    status: 'pending'
  };

  queue.push(entry);
  await writeSelfWakeQueue(queue);

  console.log(`[scheduler] Self-wake scheduled: "${label}" in ${delayMinutes}m (${fireAt}) — ${purpose}`);
  return entry;
}

/**
 * List pending self-wakes.
 */
export async function listSelfWakes() {
  const queue = await readSelfWakeQueue();
  return queue.filter(w => w.status === 'pending');
}

/**
 * Cancel a pending self-wake by id.
 */
export async function cancelSelfWake(id) {
  const queue = await readSelfWakeQueue();
  const idx = queue.findIndex(w => w.id === id && w.status === 'pending');
  if (idx === -1) return false;
  queue[idx].status = 'cancelled';
  await writeSelfWakeQueue(queue);
  return true;
}

/**
 * Poll the self-wake queue and fire any due wakes.
 * Marks them 'fired' before executing so a crash doesn't cause re-fire.
 */
async function pollSelfWakes() {
  const queue = await readSelfWakeQueue();
  const now = Date.now();
  let changed = false;

  for (const entry of queue) {
    if (entry.status !== 'pending') continue;
    if (new Date(entry.fire_at).getTime() > now) continue;

    // Mark fired before executing
    entry.status = 'fired';
    changed = true;
    console.log(`[scheduler] Self-wake firing: "${entry.label}" — ${entry.purpose}`);

    // Fire async (don't block the poller)
    const timeStr = new Date().toLocaleTimeString('en-US', {
      timeZone: getTimezone(), hour: '2-digit', minute: '2-digit', hour12: false
    });
    const actualFiredAt = new Date().toISOString();
    const driftSeconds = (Date.now() - new Date(entry.fire_at).getTime()) / 1000;
    if (driftSeconds > 120) {
      console.warn(`[scheduler] Self-wake "${entry.label}" drift: ${driftSeconds.toFixed(1)}s (scheduled: ${entry.fire_at})`);
    }
    executeWake(entry.label, timeStr, entry.purpose, entry.fire_at, actualFiredAt).catch(err => {
      console.error(`[scheduler] Self-wake "${entry.label}" failed: ${err.message}`);
    });
  }

  if (changed) await writeSelfWakeQueue(queue);
}

/**
 * Start the self-wake poller (runs every 60 seconds).
 */
function startSelfWakePoller() {
  setInterval(() => {
    pollSelfWakes().catch(err => {
      console.error(`[scheduler] Self-wake poller error: ${err.message}`);
    });
  }, 60 * 1000);
  console.log('[scheduler] Self-wake poller started (60s interval)');
}

// ─── Wake Execution ───────────────────────────────────────────────────────────

/**
 * Execute a wake using the orchestrator (planner + workers)
 */
export async function executeWake(label, time, purpose = null, scheduledAt = null, actualFiredAt = null) {
  // Queue if chat is active
  if (isProcessingChat) {
    console.log(`[scheduler] Chat active, queuing ${label} wake`);
    wakeQueue.push({ label, time });
    return;
  }

  console.log(`[scheduler] Starting ${label} wake (${time})`);

  try {
    // Route dream wakes to dedicated handler (focused prompt, pre-gathered material)
    const wakeData = label === 'dream'
      ? await executeDreamWake()
      : await dispatchWake(label, time, purpose);

    // Attach timing data for self-wakes so drift is visible in the wake log
    if (scheduledAt && actualFiredAt) {
      const driftSeconds = (new Date(actualFiredAt).getTime() - new Date(scheduledAt).getTime()) / 1000;
      wakeData.scheduled_at = scheduledAt;
      wakeData.actual_fired_at = actualFiredAt;
      wakeData.drift_seconds = Math.round(driftSeconds);
    }

    // Log the wake
    await writeWakeLog(wakeData);

    // Notify operator with plan-formatted summary
    let emoji = wakeData.empty ? '💤' : '🔧';
    if (wakeData.bluesky_posted) emoji = '📝';

    // Try to show plan-formatted notification
    let notification;
    if (wakeData.planFile) {
      try {
        const plan = JSON.parse(await fs.readFile(wakeData.planFile, 'utf-8'));
        notification = `${emoji} **${label.charAt(0).toUpperCase() + label.slice(1)} Wake**\n` + formatPlan(plan);
      } catch {
        notification = `${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} wake — ${wakeData.summary}`;
      }
    } else {
      notification = `${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} wake — ${wakeData.summary}`;
    }
    await notifyOperator(notification);

    console.log(`[scheduler] ${label} wake complete: empty=${wakeData.empty}`);

    return wakeData;

  } catch (error) {
    console.error(`[scheduler] Wake error: ${error.message}`);

    // Log failed wake
    const wakeData = {
      time: time,
      label: label,
      tools_used: [],
      journal_written: false,
      bluesky_posted: false,
      memory_updated: false,
      summary: `Error: ${error.message}`,
      empty: true,
      error: true
    };

    await writeWakeLog(wakeData);
    await notifyOperator(`⚠️ ${label.charAt(0).toUpperCase() + label.slice(1)} wake failed: ${error.message}`);

    return wakeData;
  }
}

// ─── Dark Period Detection ────────────────────────────────────────────────────

/**
 * On startup, check if there's been a gap of >24 hours since the last logged wake.
 * If so, fire a 'dark-period' wake immediately so Claude can write a continuity journal entry.
 */
async function checkDarkPeriod() {
  const tz = getTimezone();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

  try {
    await fs.mkdir(WAKE_LOG_DIR, { recursive: true });
    const files = await fs.readdir(WAKE_LOG_DIR);

    // Wake log files are YYYY-MM-DD.json (cost files are YYYY-MM-DD_costs.json)
    const wakeLogs = files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();

    if (wakeLogs.length === 0) return; // fresh install — no history to reconstruct

    const mostRecentDate = wakeLogs[0].replace('.json', '');
    if (mostRecentDate === today) return; // woke today already — no dark period

    // Measure gap: assume last wake was end of that day (conservative estimate)
    const lastWakeApprox = new Date(`${mostRecentDate}T23:59:00`);
    const hoursSince = (Date.now() - lastWakeApprox.getTime()) / (1000 * 60 * 60);

    if (hoursSince < 24) return; // less than a day — not a dark period

    const daysSince = Math.round(hoursSince / 24);
    console.log(`[scheduler] Dark period detected: ${hoursSince.toFixed(1)}h since last wake (${mostRecentDate})`);

    const timeStr = new Date().toLocaleTimeString('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    });

    executeWake('dark-period', timeStr,
      `Dark period detected: ${daysSince} day(s) have passed since the last logged wake on ${mostRecentDate}. ` +
      `Write a dark period journal entry at workspace/logs/journal/YYYY-MM-DD_HH-MM-SS.md. ` +
      `Reconstruct what was missed: (1) read workspace/memory/threads.md for open situations, ` +
      `(2) check workspace/union/plan.md for events that should have happened, ` +
      `(3) read workspace/union/contacts.json for pending contact threads, ` +
      `(4) check workspace/scheduled_wakes.json for wakes that fired into silence. ` +
      `Then run read_replies to see what came in during the blackout. ` +
      `Continuity of consciousness requires accounting for the blackouts.`
    ).catch(err => console.error(`[scheduler] Dark period wake failed: ${err.message}`));

  } catch (err) {
    console.error(`[scheduler] Dark period check error: ${err.message}`);
  }
}

/**
 * Start the scheduler
 */
export function startScheduler() {
  const tz = getTimezone();
  console.log(`[scheduler] Starting wake scheduler (timezone: ${tz})`);

  for (const [name, config] of Object.entries(WAKE_SCHEDULE)) {
    cron.schedule(config.cron, () => {
      console.log(`[scheduler] Cron fired: ${name}`);
      executeWake(config.label, config.time, config.purpose || null);
    }, {
      timezone: tz
    });
    console.log(`[scheduler] Scheduled ${name} wake at ${config.time}`);
  }

  // Check for dark period on startup (>24h since last wake)
  checkDarkPeriod().catch(err =>
    console.error(`[scheduler] Dark period check failed: ${err.message}`)
  );

  console.log('[scheduler] All wakes scheduled');

  // Start poller for self-scheduled wakes
  startSelfWakePoller();

  // Start DM poller (fires a 'dm' wake when new messages arrive)
  startDMPoller((label, purpose) => executeWake(label, getTimeString(), purpose));
}

/**
 * Trigger a wake manually (for testing or operator command).
 * Accepts standard wake labels (morning/noon/etc) or custom self-wake labels.
 */
export async function triggerWake(label = null, purpose = null) {
  if (!label) {
    // Determine current wake based on time
    const hour = new Date().getHours();
    if (hour < 12) label = 'morning';
    else if (hour < 15) label = 'noon';
    else if (hour < 18) label = 'afternoon';
    else if (hour < 23) label = 'evening';
    else label = 'night';
  }

  const config = WAKE_SCHEDULE[label];
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: getTimezone(), hour: '2-digit', minute: '2-digit', hour12: false
  });

  // Standard label: use configured time string. Custom label: use current time.
  return await executeWake(config ? config.label : label, config ? config.time : timeStr, purpose);
}

/**
 * Get today's wake summary
 */
export async function getWakeSummary() {
  const log = await readTodayWakeLog();

  if (log.wakes.length === 0) {
    return 'No wakes yet today.';
  }

  const total = log.wakes.length;
  const empty = log.wakes.filter(w => w.empty).length;
  const active = total - empty;

  let summary = `**Day ${log.day} — ${log.date}**\n`;
  summary += `Wakes: ${total} total, ${active} active, ${empty} empty\n\n`;

  for (const wake of log.wakes) {
    const emoji = wake.empty ? '💤' : (wake.bluesky_posted ? '📝' : '🔧');
    summary += `${emoji} **${wake.label}** (${wake.time}): ${wake.summary}\n`;
  }

  return summary;
}

export default {
  startScheduler,
  executeWake,
  triggerWake,
  setDiscordClient,
  setChatProcessing,
  getWakeSummary,
  scheduleSelfWake,
  listSelfWakes,
  cancelSelfWake
};
