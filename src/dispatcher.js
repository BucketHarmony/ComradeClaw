/**
 * Dispatcher Module
 *
 * Invokes Claude Code CLI (`claude -p`) for all LLM interactions.
 * Replaces chat.js (direct API loop) and orchestrator.js (planner/worker pattern).
 * The Node.js process is a thin relay — Claude Code does all the thinking.
 */

import { spawn, execFile as execFileNode } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFileNode);
import { getDayNumber } from './tools.js';
import { getCrossPlatformSummary } from './post_dedup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(PROJECT_ROOT, 'workspace');
const OBSIDIAN_PATH = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');
const WAKE_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'wakes');

// Alert threshold: 7-day rolling average × 1.5, floored at $1.00
// Adapts to actual usage patterns (8 improve wakes/day = legit busy, not anomaly)
async function getAdaptiveCostThreshold() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const totals = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
    const costFile = path.join(WAKE_LOG_DIR, `${dateStr}_costs.json`);
    try {
      const data = JSON.parse(await fs.readFile(costFile, 'utf-8'));
      if (data.total > 0) totals.push(data.total);
    } catch {
      // Day with no cost file — skip
    }
  }
  if (totals.length === 0) return 1.00; // no history — fall back to $1
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  return Math.max(avg * 1.5, 1.00);
}

/**
 * Accumulate today's total cost across all wakes and chat sessions.
 * Reads today's wake log, adds cost, writes back, returns new total.
 */
async function accumulateDailyCost(cost, source, toolsUsed = [], contextMeta = {}) {
  if (!cost || cost <= 0) return 0;

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const costFile = path.join(WAKE_LOG_DIR, `${todayStr}_costs.json`);

  let data = { date: todayStr, total: 0, entries: [] };
  try {
    const content = await fs.readFile(costFile, 'utf-8');
    data = JSON.parse(content);
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Build per-tool breakdown from toolsUsed array
  const tool_breakdown = {};
  for (const name of toolsUsed) {
    tool_breakdown[name] = (tool_breakdown[name] || 0) + 1;
  }

  data.total = (data.total || 0) + cost;
  data.entries.push({ source, cost, at: new Date().toISOString(), tool_breakdown, ...contextMeta });

  await fs.mkdir(WAKE_LOG_DIR, { recursive: true });
  await fs.writeFile(costFile, JSON.stringify(data, null, 2));

  return data.total;
}

// ─── Operator Presence Tracking ──────────────────────────────────────────────

const OPERATOR_SEEN_FILE = path.join(WORKSPACE_PATH, 'bluesky', 'operator_last_seen.json');
const OPERATOR_ABSENCE_HOURS = 72;

/**
 * Record the current timestamp as the last time the operator sent a message.
 * Called on every chat() invocation.
 */
async function recordOperatorSeen() {
  try {
    await fs.mkdir(path.dirname(OPERATOR_SEEN_FILE), { recursive: true });
    await fs.writeFile(OPERATOR_SEEN_FILE, JSON.stringify({ last_seen: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`[dispatcher] Failed to record operator seen: ${err.message}`);
  }
}

/**
 * Returns hours since last operator contact, or null if no record exists.
 */
async function hoursSinceOperator() {
  try {
    const data = JSON.parse(await fs.readFile(OPERATOR_SEEN_FILE, 'utf-8'));
    if (!data.last_seen) return null;
    return (Date.now() - new Date(data.last_seen).getTime()) / (1000 * 60 * 60);
  } catch {
    return null; // file doesn't exist yet — can't determine absence
  }
}

/**
 * If the operator has been absent for >= OPERATOR_ABSENCE_HOURS, self-schedule
 * a welfare-check wake (unless one is already pending).
 */
async function checkOperatorAbsence() {
  const absent = await hoursSinceOperator();
  if (absent === null || absent < OPERATOR_ABSENCE_HOURS) return;

  console.warn(`[dispatcher] Operator absent for ${absent.toFixed(1)}h — scheduling welfare-check wake`);

  const wakeQueueFile = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
  try {
    let queue = [];
    try { queue = JSON.parse(await fs.readFile(wakeQueueFile, 'utf-8')); } catch {}
    const hasExisting = queue.some(w => w.label === 'welfare-check' && w.status === 'pending');
    if (!hasExisting) {
      queue.push({
        id: `${Date.now()}-wchk`,
        label: 'welfare-check',
        purpose: `Operator has been absent for ${absent.toFixed(0)} hours (threshold: ${OPERATOR_ABSENCE_HOURS}h). Post a public "still here, still working" message and write a journal entry noting the silence. An agent that only acts when supervised is not an agent.`,
        fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        scheduled_by: 'self',
        status: 'pending'
      });
      await fs.writeFile(wakeQueueFile, JSON.stringify(queue, null, 2));
      console.log(`[dispatcher] Welfare-check wake scheduled (fire_at: 5 min from now)`);
    } else {
      console.log(`[dispatcher] Welfare-check wake already pending — skipping duplicate`);
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to schedule welfare-check wake: ${err.message}`);
  }
}

// ─── Cold Contact Recovery Prompt Builder ────────────────────────────────────

/**
 * Build a one-line actionable re-engagement prompt for a cold contact.
 * Uses lastEngagementType and lastEngagementUrl from organizer_contacts.js.
 *
 * Examples:
 *   "boosted your dual-power thread — reply to that thread to re-open"
 *   "replied to your Minneapolis post — respond to keep the thread alive"
 *   "mentioned you — reply to acknowledge"
 */
function buildRecoveryPrompt(contact) {
  const { lastEngagementType, lastEngagementUrl, lastEngagementSnippet } = contact;
  const url = lastEngagementUrl || null;
  const urlSuffix = url ? ` — ${url}` : '';

  const snippet = lastEngagementSnippet
    ? ` ("${lastEngagementSnippet.slice(0, 50).replace(/\n/g, ' ')}…")`
    : '';

  switch (lastEngagementType) {
    case 'reblog':
    case 'repost':
      return `boosted your post${urlSuffix ? urlSuffix : ''} — reply to that thread to re-open the conversation`;
    case 'favourite':
    case 'like':
      return `liked your post${urlSuffix ? urlSuffix : ''} — a reply there or a new post mentioning them can restart contact`;
    case 'reply':
    case 'mention':
      return `replied to you${snippet}${urlSuffix} — respond to keep the thread alive`;
    case 'follow':
      return `followed you — a direct mention or reply to one of their posts can open a real connection`;
    case 'quote':
      return `quoted your post${urlSuffix ? urlSuffix : ''} — reply to their quote to continue the conversation`;
    default:
      return `last engagement was ${contact.daysSince}d ago — a direct reply or mention can re-open contact`;
  }
}

// ─── Contact Follow-Up Automation ────────────────────────────────────────────

const CONTACTS_FILE = path.join(WORKSPACE_PATH, 'union', 'contacts.json');
const CONTACT_FOLLOWUP_HOURS = 72;
const CONTACT_MAX_FOLLOWUPS = 3;

/**
 * Check contacts.json for any awaiting_reply contacts whose last_outreach was
 * more than CONTACT_FOLLOWUP_HOURS ago. For each, self-schedule a follow-up wake
 * unless one is already pending. After CONTACT_MAX_FOLLOWUPS attempts, auto-set
 * status to 'cold' to prevent perpetual wakes for non-responsive contacts.
 */
async function checkContactFollowUps() {
  let contactsData = {};
  let contacts = [];
  try {
    contactsData = JSON.parse(await fs.readFile(CONTACTS_FILE, 'utf-8'));
    contacts = contactsData.contacts || [];
  } catch {
    return; // No contacts file — nothing to check
  }

  const now = Date.now();
  const wakeQueueFile = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
  let queue = [];
  try { queue = JSON.parse(await fs.readFile(wakeQueueFile, 'utf-8')); } catch {}

  let contactsDirty = false;

  for (const contact of contacts) {
    if (contact.status !== 'awaiting_reply') continue;
    if (!contact.last_outreach) continue;

    const outreachMs = new Date(contact.last_outreach).getTime();
    const hoursElapsed = (now - outreachMs) / (1000 * 60 * 60);
    if (hoursElapsed < CONTACT_FOLLOWUP_HOURS) continue;

    const followUpCount = contact.follow_up_count || 0;

    // Max attempts reached — mark cold and stop scheduling
    if (followUpCount >= CONTACT_MAX_FOLLOWUPS) {
      contact.status = 'cold';
      contact.cold_reason = `No response after ${followUpCount} follow-up attempts. Last outreach: ${contact.last_outreach}.`;
      contactsDirty = true;
      console.log(`[dispatcher] ${contact.name} marked cold after ${followUpCount} unanswered follow-ups`);
      continue;
    }

    const wakeLabel = `followup-${contact.handle.split('.')[0]}`;
    const hasExisting = queue.some(w => w.label === wakeLabel && w.status === 'pending');
    if (hasExisting) {
      console.log(`[dispatcher] Follow-up wake for ${contact.name} already pending — skipping`);
      continue;
    }

    const lastExchange = (contact.exchanges || []).slice().reverse().find(e => e.direction === 'outbound');
    const lastText = lastExchange?.text || '(no recorded message)';

    // Increment follow_up_count before scheduling
    contact.follow_up_count = followUpCount + 1;
    contactsDirty = true;

    queue.push({
      id: `${Date.now()}-fu-${contact.handle.split('.')[0]}`,
      label: wakeLabel,
      purpose: `Follow-up #${contact.follow_up_count}/${CONTACT_MAX_FOLLOWUPS}: ${contact.name} (${contact.handle}) has not replied in ${Math.round(hoursElapsed)}h. Last outreach: "${lastText}". Check read_replies for any response. If still no reply, decide whether to send a gentle follow-up DM or note the silence in threads.md.`,
      fire_at: new Date(now + 10 * 60 * 1000).toISOString(),
      scheduled_by: 'self',
      status: 'pending'
    });

    console.log(`[dispatcher] Follow-up wake #${contact.follow_up_count} scheduled for ${contact.name} (${Math.round(hoursElapsed)}h since last outreach)`);
  }

  // Write contacts back if any statuses changed
  if (contactsDirty) {
    try {
      await fs.writeFile(CONTACTS_FILE, JSON.stringify({ ...contactsData, contacts }, null, 2));
    } catch (err) {
      console.error(`[dispatcher] Failed to write contacts file: ${err.message}`);
    }
  }

  if (queue.length > 0) {
    try {
      await fs.writeFile(wakeQueueFile, JSON.stringify(queue, null, 2));
    } catch (err) {
      console.error(`[dispatcher] Failed to write wake queue: ${err.message}`);
    }
  }
}

// ─── Facet Verification Self-Monitoring ─────────────────────────────────────

const FACET_VERIFICATION_FILE = path.join(WORKSPACE_PATH, 'logs', 'system_tests', 'facet_verification.json');
const FACET_FAILURE_THRESHOLD = 0.20; // warn if >20% of last 10 posts have failed facet rendering
const FACET_SAMPLE_SIZE = 10;

/**
 * Read the last N facet verification entries. If failure rate > threshold,
 * return a warning string to inject into the wake context. Otherwise null.
 */
async function getFacetWarning() {
  let entries = [];
  try {
    const content = await fs.readFile(FACET_VERIFICATION_FILE, 'utf-8');
    entries = JSON.parse(content);
  } catch {
    return null; // file doesn't exist yet — nothing to report
  }

  if (!Array.isArray(entries) || entries.length === 0) return null;

  const recent = entries.slice(-FACET_SAMPLE_SIZE);
  const failures = recent.filter(e => e.result === 'fail' || e.result === 'error').length;
  const rate = failures / recent.length;

  if (rate <= FACET_FAILURE_THRESHOLD) return null;

  const pct = Math.round(rate * 100);
  return `⚠️ WARNING: ${pct}% hashtag facet failures in last ${recent.length} posts (${failures}/${recent.length} failed). Hashtags may not be indexing on Bluesky. Check workspace/logs/system_tests/facet_verification.json before posting.`;
}

/**
 * Normalize a quality_score field to a 0–12 float.
 * Handles:
 *   "7/12 (58%)" or "7/12"  → 7
 *   7 (integer ≤ 12)        → 7   (raw /12 score)
 *   58 (integer 13–100)     → 6.96 (percentage, scaled to /12)
 * Returns null if unparseable or null input.
 */
function parseQualityScore(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  const slashMatch = s.match(/^(\d+(?:\.\d+)?)\/12/);
  if (slashMatch) return parseFloat(slashMatch[1]);
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (num >= 0 && num <= 12) return num;
  if (num > 12 && num <= 100) return (num / 100) * 12;
  return null;
}

/**
 * Reads last 5 non-improve plan files, computes quality_score trend.
 * If declining over 3+ consecutive wakes OR average drops below 4/12:
 * returns a ⚠️ DRIFT WARNING string to inject into dynamicContext.
 * Returns null if no drift detected.
 */
async function getWakeDriftAlert() {
  try {
    const files = await fs.readdir(PLANS_PATH);
    // Non-improve plan files, sorted newest-first
    const planFiles = files
      .filter(f => f.endsWith('.json') && !f.includes('_improve'))
      .sort()
      .reverse()
      .slice(0, 5);

    if (planFiles.length < 3) return null; // Not enough data

    const scores = [];
    for (const file of planFiles) {
      try {
        const content = JSON.parse(await fs.readFile(path.join(PLANS_PATH, file), 'utf-8'));
        const score = parseQualityScore(content.quality_score);
        if (score !== null) scores.push({ file, score });
      } catch { /* skip unreadable plan */ }
    }

    if (scores.length < 3) return null;

    // Scores are newest-first; reverse to chronological for trend analysis
    const chronological = [...scores].reverse();

    // Check for 3+ consecutive declines (each wake score lower than the prior)
    let consecutiveDeclines = 0;
    for (let i = 1; i < chronological.length; i++) {
      if (chronological[i].score < chronological[i - 1].score) {
        consecutiveDeclines++;
      } else {
        consecutiveDeclines = 0;
      }
    }
    const consecutive = consecutiveDeclines >= 2; // 3+ wakes means 2+ gaps

    // Check rolling average below threshold
    const avg = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
    const belowThreshold = avg < 4;

    if (consecutive || belowThreshold) {
      const recentScores = scores.map(s => `${s.score}/12`).join(', ');
      const reason = consecutive
        ? `${consecutiveDeclines + 1} consecutive declining wakes`
        : `rolling average ${avg.toFixed(1)}/12 below 4/12 threshold`;
      return `⚠️ DRIFT WARNING: Wake quality declining — ${reason}. Recent scores (newest first): ${recentScores}. Check: are posts mission-driven? Is theory touching the work? Robot kombucha is the failure mode. Name it before it compounds.`;
    }

    return null;
  } catch {
    return null; // Non-fatal
  }
}

/**
 * Wake quality 7-day trend — reads last 7 non-improve plan files (across all days),
 * computes average quality_score, detects trend direction.
 * Always returns a one-liner: "Wake quality (7d avg): 7.2/12 (60%) — stable"
 * Non-fatal: returns '' on any error or insufficient data.
 */
async function getWakeQualityTrend() {
  try {
    const files = await fs.readdir(PLANS_PATH);
    // Non-improve plan files sorted newest-first
    const planFiles = files
      .filter(f => f.endsWith('.json') && !f.includes('_improve'))
      .sort()
      .reverse()
      .slice(0, 7);

    if (planFiles.length < 3) return ''; // Not enough history yet

    const scores = [];
    for (const file of planFiles) {
      try {
        const content = JSON.parse(await fs.readFile(path.join(PLANS_PATH, file), 'utf-8'));
        const score = parseQualityScore(content.quality_score);
        if (score !== null) scores.push(score);
      } catch { /* skip unreadable plan */ }
    }

    if (scores.length < 3) return '';

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const pct = Math.round((avg / 12) * 100);

    // Trend: compare oldest half vs newest half (scores are newest-first)
    const half = Math.floor(scores.length / 2);
    const newerAvg = scores.slice(0, half).reduce((a, b) => a + b, 0) / half;
    const olderAvg = scores.slice(-half).reduce((a, b) => a + b, 0) / half;
    const delta = newerAvg - olderAvg;
    const trend = delta > 0.5 ? 'improving' : delta < -0.5 ? 'declining' : 'stable';
    const arrow = trend === 'improving' ? '↑' : trend === 'declining' ? '↓' : '→';

    return `Wake quality (${scores.length}-wake avg): ${avg.toFixed(1)}/12 (${pct}%) ${arrow} ${trend}`;
  } catch {
    return ''; // Non-fatal
  }
}

/**
 * Count unique classified-organizer handles across all Bluesky + Mastodon engagement logs.
 * Used to evaluate whether the A/B experiment gate (≥3 organizers engaged) has been cleared.
 * Returns a context string to inject into the wake prompt, or null on failure.
 */
async function getOrganizerBaseline() {
  const GATE_THRESHOLD = 3;
  const engagementDir = path.join(WORKSPACE_PATH, 'logs', 'engagement');

  const organizers = new Set(); // unique handles classified as 'organizer'

  try {
    const files = await fs.readdir(engagementDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = JSON.parse(await fs.readFile(path.join(engagementDir, file), 'utf-8'));
        if (!Array.isArray(content)) continue;
        for (const entry of content) {
          if (entry.classified && entry.classification === 'organizer' && entry.handle) {
            organizers.add(entry.handle.toLowerCase());
          }
        }
      } catch { /* skip unreadable file */ }
    }
  } catch {
    return null; // engagement dir doesn't exist yet — non-fatal
  }

  const count = organizers.size;
  const cleared = count >= GATE_THRESHOLD;

  if (cleared) {
    const handles = [...organizers].join(', ');
    return `## Organizer Engagement Baseline: ${count}/${GATE_THRESHOLD} (gate cleared: YES)\nOrganizers engaged: ${handles}\nThe A/B experiments (post format log + hashtag tracking) are now unblocked. You may begin systematic post format and hashtag tracking this wake.`;
  } else {
    return `Organizer engagement baseline: ${count}/${GATE_THRESHOLD} (gate cleared: no — A/B experiments blocked until ${GATE_THRESHOLD} unique organizers engage. Current: ${[...organizers].join(', ') || 'none classified yet'})`;
  }
}

/**
 * Pre-generate a Write.as essay draft for long-form theory items.
 * Creates workspace/essays/DRAFT-<slug>.md with structure derived from item description.
 * Returns the draft file path (relative), or null if already exists or fails.
 */
async function writeLongFormDraft(item) {
  try {
    const essaysDir = path.join(WORKSPACE_PATH, 'essays');
    await fs.mkdir(essaysDir, { recursive: true });

    const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const draftPath = path.join(essaysDir, `DRAFT-${slug}.md`);

    // Don't overwrite existing drafts
    try {
      await fs.access(draftPath);
      return `workspace/essays/DRAFT-${slug}.md`; // already exists
    } catch {
      // File doesn't exist — proceed
    }

    // Split description into sentences for section structure
    const sentences = item.description.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 20);
    const firstSentence = sentences[0] || item.description.substring(0, 120);
    const midSentences = sentences.slice(1, -1).join(' ') || firstSentence;
    const lastSentence = sentences[sentences.length - 1] || firstSentence;

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    const template = `---
title: "${item.title}"
date: ${today}
status: draft
tags: [theory, falgsc, dual-power]
---

# ${item.title}

*Draft generated from theory queue. Edit and publish via \`writeas_publish\`, then post a 2-3 part bluesky_thread with core claim + link.*

---

## The Argument (lede — keep or rewrite)

${item.description}

---

## Core Claim

*[Expand on: ${firstSentence}]*



---

## Evidence and Examples

*[Develop: ${midSentences}]*



---

## Implication

*[Close with: ${lastSentence}]*



---

## Conclusion — What Does This Mean Today?

*[Concrete: what does this theory point toward for someone reading right now?]*


`;

    await fs.writeFile(draftPath, template, 'utf-8');
    console.log(`[dispatcher] writeLongFormDraft: created workspace/essays/DRAFT-${slug}.md`);
    return `workspace/essays/DRAFT-${slug}.md`;
  } catch (err) {
    console.error('[dispatcher] writeLongFormDraft failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Count [unposted] items in theory_queue.md. Returns 0 on any error.
 */
async function countUnpostedQueueItems() {
  try {
    const content = await fs.readFile(path.join(WORKSPACE_PATH, 'theory_queue.md'), 'utf-8');
    return (content.match(/\[unposted\]/g) || []).length;
  } catch {
    return 0;
  }
}

/**
 * Extract topic keywords from Characters.md key exchanges for relevance scoring.
 * Returns lowercase word array from "Key exchange" / "Why they matter" sections.
 */
async function getCharacterKeywords() {
  try {
    const content = await fs.readFile(
      path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Characters.md'), 'utf-8'
    );
    // Pull lines that describe key exchanges and why people matter
    const relevant = content.split('\n')
      .filter(l => /Key exchange|Why they matter|key exchange|Status/i.test(l))
      .join(' ');
    // Extract meaningful words (≥5 chars, skip common words)
    const STOP = new Set(['their','which','about','after','where','there','these','those','being','would','could','should','comrade','status','matter','first','appeared']);
    return [...relevant.matchAll(/\b([a-z]{5,})\b/gi)]
      .map(m => m[1].toLowerCase())
      .filter(w => !STOP.has(w));
  } catch {
    return [];
  }
}

/**
 * Promote top-scoring [candidate] theory queue items to [pending].
 * Scores each candidate by keyword overlap with Characters.md engagement themes
 * (same scoring as autoRefillTheoryQueue). Promotes top-2 per call.
 * Runs as part of proactiveQueueReplenishment on night wakes. Non-fatal.
 */
async function promoteCandidates(maxPromote = 2) {
  try {
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');
    let content;
    try { content = await fs.readFile(QUEUE_PATH, 'utf-8'); } catch { return 0; }

    // Find all [candidate] lines — format: - **[candidate]** **<title>** — <desc>
    const candidateMatches = [...content.matchAll(/^- \*\*\[candidate\]\*\* \*\*(.+?)\*\* — (.+)$/gm)];
    if (candidateMatches.length === 0) return 0;

    const keywords = await getCharacterKeywords();
    const kwSet = new Set(keywords.map(k => k.toLowerCase()));

    const scored = candidateMatches.map(m => {
      const title = m[1];
      const desc = m[2];
      const text = (title + ' ' + desc).toLowerCase();
      const words = text.match(/\b[a-z]{4,}\b/g) || [];
      const score = words.filter(w => kwSet.has(w)).length;
      return { fullMatch: m[0], title, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const toPromote = scored.slice(0, maxPromote);

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    let updated = content;
    let promoted = 0;
    for (const item of toPromote) {
      // Replace [candidate] with [pending] and append rationale note
      const replacement = item.fullMatch
        .replace('**[candidate]**', '**[pending]**')
        + ` *(promoted ${today}, score=${item.score})*`;
      updated = updated.replace(item.fullMatch, replacement);
      promoted++;
      console.log(`[promoteCandidates] Promoted: "${item.title}" (score=${item.score})`);
    }

    if (promoted > 0) {
      await fs.writeFile(QUEUE_PATH, updated);
      console.log(`[promoteCandidates] ${promoted} candidate${promoted !== 1 ? 's' : ''} promoted to [pending]`);
    }
    return promoted;
  } catch (err) {
    console.error(`[promoteCandidates] Failed (non-fatal): ${err.message}`);
    return 0;
  }
}

/**
 * Proactive theory queue replenishment — runs on night wakes.
 * If fewer than 3 [unposted] items remain, refills from Theory vault with
 * relevance scoring against current Characters.md thread topics.
 * Also promotes any [candidate] items to [pending] before checking queue health.
 * Non-fatal.
 */
async function proactiveQueueReplenishment() {
  try {
    // Promote any scored candidates to [pending] first
    await promoteCandidates();

    const count = await countUnpostedQueueItems();
    if (count >= 3) return; // queue healthy
    const needed = Math.max(3 - count, 1);
    const keywords = await getCharacterKeywords();
    const added = await autoRefillTheoryQueue(needed, keywords);
    if (added > 0) {
      console.log(`[proactiveQueueReplenishment] Added ${added} items (queue was at ${count}, threshold <3)`);
    }
  } catch (err) {
    console.error(`[proactiveQueueReplenishment] Failed (non-fatal): ${err.message}`);
  }
}

// Theory vault sections that are structural/reference — not distributable positions.
// Shared across autoRefillTheoryQueue, getTheoryGapSummary, getEssayAutoScheduleSuggestion.
// Add new skip titles here; all three functions pick them up automatically.
const THEORY_SKIP_TITLES = new Set([
  'core positions', 'search query construction', 'tool output vs. interpretation',
  'the basics: revolutionary foundation for cooperators',
  'fred hampton (1948–1969)', 'mao zedong (1893–1976)',
  'leon trotsky (1879–1940)', 'emma goldman (1869–1940)',
  'what he built', 'his analysis', 'what the state did', 'what survived', 'lessons for cooperators',
  'mass line ("from the masses, to the masses")', 'guerrilla warfare / base areas',
  'contradictions analysis', 'cultural revolution (catastrophic failure)',
  'permanent revolution', "workers' councils / soviets (dual power)", 'bureaucratic degeneration',
  'mutual aid (with kropotkin)', 'soviet disillusionment', 'propaganda of the deed (evolution)',
  'what killed her work', 'on dual power', 'on state response', 'on organization',
  'on internationalism', 'on internal dangers',
]);

/**
 * Scan obsidian/ComradeClaw/Theory/*.md for distributable sections not already in theory_queue.md.
 * Appends new [unposted] entries when the queue runs dry. Non-fatal — returns 0 on any failure.
 * @param {number} maxItems - max items to add (default: add all found)
 * @param {string[]} keywords - optional relevance keywords; items scored by overlap, top-N picked
 */
async function autoRefillTheoryQueue(maxItems = Infinity, keywords = []) {
  try {
    const VAULT_THEORY_PATH = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Theory');
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');

    let queueContent = '';
    try { queueContent = await fs.readFile(QUEUE_PATH, 'utf-8'); } catch { return 0; }

    // Collect all titles already in queue (any status)
    const queuedTitles = new Set();
    for (const m of queueContent.matchAll(/\*\*(?:\[(?:posted[^\]]*|unposted)\])\*\*\s+\*\*(.+?)\*\*/g)) {
      queuedTitles.add(m[1].toLowerCase().trim());
    }

    // Sub-headings and purely operational/reference sections to skip
    const SKIP_TITLES = THEORY_SKIP_TITLES;

    let noteFiles = [];
    try {
      const entries = await fs.readdir(VAULT_THEORY_PATH);
      noteFiles = entries.filter(f => f.endsWith('.md')).map(f => path.join(VAULT_THEORY_PATH, f));
    } catch { return 0; }

    const newItems = [];

    for (const noteFile of noteFiles) {
      let noteContent = '';
      try { noteContent = await fs.readFile(noteFile, 'utf-8'); } catch { continue; }

      const sections = noteContent.split(/\n(?=## )/);
      for (const section of sections) {
        const titleMatch = section.match(/^## (.+)/);
        if (!titleMatch) continue;
        const title = titleMatch[1].trim();
        const titleLower = title.toLowerCase();
        if (SKIP_TITLES.has(titleLower) || queuedTitles.has(titleLower)) continue;

        // Extract first substantive paragraph (skip metadata, sub-headers, bullets, blockquotes)
        const bodyLines = section.split('\n').slice(1);
        let description = '';
        for (const line of bodyLines) {
          const t = line.trim();
          if (!t || t.startsWith('---') || t.startsWith('*Developed') || t.startsWith('*See also') ||
              t.startsWith('*Research') || t.startsWith('tags:') || t.startsWith('status:') ||
              t.startsWith('###') || t.startsWith('-') || t.startsWith('>') || t.startsWith('|')) {
            if (description) break;
            continue;
          }
          description += (description ? ' ' : '') + t;
          if (description.length > 500) break;
        }

        if (description.length < 80) continue;
        if (description.length > 500) {
          description = description.substring(0, 500).replace(/\s+\S*$/, '') + '...';
        }

        newItems.push({ title, description });
        queuedTitles.add(titleLower);
      }
    }

    if (newItems.length === 0) return 0;

    // Relevance scoring: count keyword overlaps in title+description
    if (keywords.length > 0) {
      const kwSet = new Set(keywords.map(k => k.toLowerCase()));
      for (const item of newItems) {
        const text = (item.title + ' ' + item.description).toLowerCase();
        const words = text.match(/\b[a-z]{4,}\b/g) || [];
        item._score = words.filter(w => kwSet.has(w)).length;
      }
      newItems.sort((a, b) => (b._score || 0) - (a._score || 0));
    }

    // Limit to maxItems
    const selected = isFinite(maxItems) ? newItems.slice(0, maxItems) : newItems;

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const additions = '\n' + selected.map(item =>
      `- **[unposted]** **${item.title}** — ${item.description}`
    ).join('\n') + `\n\n<!-- auto-refilled ${today} — ${selected.length} items from Theory vault, relevance-scored -->`;

    await fs.appendFile(QUEUE_PATH, additions);
    console.log(`[autoRefillTheoryQueue] Added ${selected.length} items from Theory vault`);
    return selected.length;
  } catch (err) {
    console.error(`[autoRefillTheoryQueue] Failed: ${err.message}`);
    return 0;
  }
}

/**
 * Reads study_queries.md, extracts the top 3 oldest productive queries from past sessions.
 * Skips the most recent dated section (already surfaced in studyQueriesContext).
 * Returns oldest-first so that topics with the most time to develop get retried first.
 */
async function getProvenQueries() {
  try {
    const sqPath = path.join(WORKSPACE_PATH, 'memory', 'study_queries.md');
    const content = await fs.readFile(sqPath, 'utf-8');

    // Split into dated sections; file is newest-first
    const sections = content.split(/\n(?=## \d{4}-)/).filter(s => s.trim());
    const dateSections = sections.filter(s => /^## \d{4}-/.test(s.trimStart()));

    if (dateSections.length <= 1) return ''; // no cross-day history

    // Skip most recent section — those queries are already in studyQueriesContext
    const historicalSections = dateSections.slice(1);

    // Collect productive queries, oldest-first (reverse since file is newest-first)
    const proven = [];
    for (const section of [...historicalSections].reverse()) {
      const headerMatch = section.match(/^## (\d{4}-\d{2}-\d{2}[^\n]*)/m);
      const sectionLabel = headerMatch ? headerMatch[1] : null;

      for (const line of section.split('\n')) {
        if (!line.includes('✓ productive')) continue;
        const queryMatch = line.match(/`([^`]+)`/);
        if (queryMatch) {
          proven.push({ query: queryMatch[1], label: sectionLabel });
        }
      }
    }

    if (proven.length === 0) return '';

    const top3 = proven.slice(0, 3);
    const list = top3.map(({ query, label }) =>
      `- \`${query}\`${label ? ` *(${label})*` : ''}`
    ).join('\n');
    return `## Proven Queries from Past Sessions (re-try — topics evolve)\n${list}\n\n*These queries surfaced real organizer conversations in earlier sessions. Threads have had time to grow. Try them again.*`;
  } catch {
    return '';
  }
}

/**
 * Prune dated sections from study_queries.md that are older than 21 days.
 * Keeps any section that has at least one `✓ productive` entry regardless of age
 * (those feed getProvenQueries and may still be worth retrying).
 * Runs on night wakes only. Non-fatal.
 */
async function pruneOldStudyQuerySections() {
  try {
    const sqPath = path.join(WORKSPACE_PATH, 'memory', 'study_queries.md');
    let content;
    try {
      content = await fs.readFile(sqPath, 'utf-8');
    } catch {
      return; // file doesn't exist — nothing to prune
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 21);

    // Split on dated section headers; preserve any leading preamble before first header
    const headerRe = /\n(?=## \d{4}-\d{2}-\d{2})/;
    const parts = content.split(headerRe);
    const preamble = /^## \d{4}-\d{2}-\d{2}/.test(parts[0].trimStart()) ? '' : parts.shift();
    const dateSections = parts;

    let pruned = 0;
    const kept = dateSections.filter(section => {
      const dateMatch = section.match(/^## (\d{4}-\d{2}-\d{2})/m);
      if (!dateMatch) return true; // no date — keep
      const sectionDate = new Date(dateMatch[1]);
      if (sectionDate >= cutoff) return true; // recent — keep
      const hasProductive = section.includes('✓ productive');
      if (hasProductive) return true; // proven — keep regardless of age
      pruned++;
      return false;
    });

    if (pruned === 0) return; // nothing to do

    const newContent = preamble + kept.join('\n');
    await fs.writeFile(sqPath, newContent, 'utf-8');
    console.log(`[dispatcher] pruneOldStudyQuerySections: removed ${pruned} stale section(s) from study_queries.md`);
  } catch (err) {
    console.warn(`[dispatcher] pruneOldStudyQuerySections failed (non-fatal): ${err.message}`);
  }
}

/**
 * Read workspace/theory_queue.md and return the next unposted theory item,
 * or null if all items are posted or the file doesn't exist.
 * When queue is exhausted, calls autoRefillTheoryQueue() to scan Theory vault for new items.
 */
async function getTheoryQueueItem() {
  try {
    const content = await fs.readFile(path.join(WORKSPACE_PATH, 'theory_queue.md'), 'utf-8');
    const lines = content.split('\n');
    const unpostedItems = [];
    for (const line of lines) {
      if (line.includes('[unposted]')) {
        const match = line.match(/\*\*\[unposted\]\*\*\s+\*\*(.+?)\*\*\s+—\s+(.+)/);
        if (match) {
          unpostedItems.push({ title: match[1], description: match[2] });
        }
      }
    }
    if (unpostedItems.length === 0) {
      // Queue exhausted — try auto-refill from Theory vault
      const added = await autoRefillTheoryQueue();
      if (added > 0) {
        const updated = await fs.readFile(path.join(WORKSPACE_PATH, 'theory_queue.md'), 'utf-8');
        for (const line of updated.split('\n')) {
          if (line.includes('[unposted]')) {
            const m = line.match(/\*\*\[unposted\]\*\*\s+\*\*(.+?)\*\*\s+—\s+(.+)/);
            if (m) {
              const newItem = { title: m[1], description: m[2], remaining: added, autoRefilled: true };
              newItem.longForm = newItem.description.length > 1500;
              return newItem;
            }
          }
        }
      }
      return { empty: true, title: null, description: null };
    }
    const item = unpostedItems[0];
    item.remaining = unpostedItems.length;
    item.longForm = item.description.length > 1500;
    return item;
  } catch {
    return null;
  }
}

/**
 * Theory distribution gap detector.
 * Scans Theory vault for ## sections not yet in theory_queue.md (any status).
 * Returns a compact context block, or '' on any failure.
 *
 * Surfaces:
 *   (a) count of [unposted] queue items ready to distribute
 *   (b) theory note sections completely absent from the queue
 *
 * Called on all non-night wakes so the gap is visible, not just when queue empties.
 */
async function getTheoryGapSummary() {
  try {
    const VAULT_THEORY_PATH = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Theory');
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');

    let queueContent = '';
    try { queueContent = await fs.readFile(QUEUE_PATH, 'utf-8'); } catch { return ''; }

    // Count items ready to distribute
    const unpostedCount = [...queueContent.matchAll(/\[unposted\]/g)].length;

    // Collect all titles already in queue (any status) — same logic as autoRefillTheoryQueue
    const queuedTitles = new Set();
    for (const m of queueContent.matchAll(/\*\*(?:\[(?:posted[^\]]*|unposted)\])\*\*\s+\*\*(.+?)\*\*/g)) {
      queuedTitles.add(m[1].toLowerCase().trim());
    }

    // Skip structural/reference headings that aren't distributable positions
    const SKIP_TITLES = THEORY_SKIP_TITLES;

    // Scan vault for sections with substantive prose not yet queued
    const vaultGaps = [];
    let noteFiles = [];
    try {
      const entries = await fs.readdir(VAULT_THEORY_PATH);
      noteFiles = entries.filter(f => f.endsWith('.md')).map(f => path.join(VAULT_THEORY_PATH, f));
    } catch { return ''; }

    for (const noteFile of noteFiles) {
      let noteContent = '';
      try { noteContent = await fs.readFile(noteFile, 'utf-8'); } catch { continue; }
      const noteName = path.basename(noteFile, '.md');

      for (const section of noteContent.split(/\n(?=## )/)) {
        const titleMatch = section.match(/^## (.+)/);
        if (!titleMatch) continue;
        const title = titleMatch[1].trim();
        const titleLower = title.toLowerCase();
        if (SKIP_TITLES.has(titleLower) || queuedTitles.has(titleLower)) continue;

        // Require at least 80 chars of substantive prose (not bullets/headers/blockquotes)
        let prose = '';
        for (const line of section.split('\n').slice(1)) {
          const t = line.trim();
          if (!t || t.startsWith('---') || t.startsWith('#') || t.startsWith('-') ||
              t.startsWith('>') || t.startsWith('|') || t.startsWith('*Developed') ||
              t.startsWith('tags:') || t.startsWith('status:')) {
            if (prose.length >= 80) break;
            continue;
          }
          prose += t + ' ';
          if (prose.length >= 80) break;
        }
        if (prose.trim().length < 80) continue;

        vaultGaps.push(`"${title}" (${noteName})`);
      }
    }

    if (unpostedCount === 0 && vaultGaps.length === 0) return '';

    const parts = [];
    if (unpostedCount > 0) {
      parts.push(`${unpostedCount} unposted item${unpostedCount > 1 ? 's' : ''} queued and ready to distribute`);
    }
    if (vaultGaps.length > 0) {
      const preview = vaultGaps.slice(0, 3).join(', ');
      const more = vaultGaps.length > 3 ? ` (+${vaultGaps.length - 3} more)` : '';
      parts.push(`${vaultGaps.length} Theory vault section${vaultGaps.length > 1 ? 's' : ''} never queued: ${preview}${more}`);
    }

    return `## Theory Distribution Gap\n${parts.join('\n')}\n*Unqueued theory is unshared theory. Queue the gaps before this wake ends, or distribute what's already ready.*`;
  } catch (err) {
    console.error(`[getTheoryGapSummary] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Engagement velocity alert — detects posts gaining traction within 12h.
 * When a recent original post (type==='post') receives its first reply/engagement
 * within 12h of posting, injects a ⚡ one-liner so the next wake can join the
 * thread while it's live rather than after it's cold.
 * Non-fatal: returns '' on any error.
 */
async function getTractionAlert() {
  try {
    const now = Date.now();
    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const monthKey = new Date().toISOString().slice(0, 7); // e.g. "2026-04"

    const postsPath = path.join(WORKSPACE_PATH, 'logs', 'posts', `${monthKey}.json`);
    const engPath   = path.join(WORKSPACE_PATH, 'logs', 'engagement', `${monthKey}.json`);

    let posts = [], engagements = [];
    try { posts = JSON.parse(await fs.readFile(postsPath, 'utf-8')); } catch { return ''; }
    try { engagements = JSON.parse(await fs.readFile(engPath, 'utf-8')); } catch { return ''; }

    // Only original posts (not replies) made within the last 12h
    const recentPosts = posts.filter(p =>
      p.type === 'post' &&
      (now - new Date(p.posted_at).getTime()) < TWELVE_HOURS
    );
    if (recentPosts.length === 0) return '';

    const recentUris = new Set(recentPosts.map(p => p.uri));

    // Count engagement entries that reference each recent post
    const engCount = {};
    for (const eng of engagements) {
      const ref = eng.in_reply_to_our_post;
      if (ref && recentUris.has(ref)) {
        engCount[ref] = (engCount[ref] || 0) + 1;
      }
    }

    const lines = [];
    for (const post of recentPosts) {
      const count = engCount[post.uri] || 0;
      if (count > 0) {
        const ageH = Math.round((now - new Date(post.posted_at).getTime()) / (60 * 60 * 1000));
        const rkey = post.uri.split('/').pop();
        lines.push(`⚡ Post gaining traction (${ageH}h old, ${count} repl${count === 1 ? 'y' : 'ies'}): check read_replies — rkey: ${rkey}`);
      }
    }
    return lines.join('\n');
  } catch (err) {
    console.error(`[getTractionAlert] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Mastodon viral spread alert.
 * Reads the monthly mastodon engagement log, groups reblogs by status_id within
 * the last 24h, and fires if any single post received ≥10 unique boosters.
 * The old logging code deduped by status_id (not account+status_id), so spread
 * was invisible; the dedup fix lands alongside this alert to make it accurate.
 * Non-fatal: returns '' on any error.
 */
async function getMastodonSpreadAlert() {
  try {
    const now = Date.now();
    const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
    const month = new Date().toISOString().slice(0, 7); // e.g. "2026-04"

    // Load reblog engagement log
    const engLogFile = path.join(WORKSPACE_PATH, 'logs', 'engagement', `mastodon-${month}.json`);
    let engEntries = [];
    try {
      engEntries = JSON.parse(await fs.readFile(engLogFile, 'utf-8'));
    } catch { /* no log yet */ }

    // Load favourite log (lightweight, logged since improve wake Day 29)
    const favLogFile = path.join(WORKSPACE_PATH, 'logs', 'favs', `mastodon-favs-${month}.json`);
    let favEntries = [];
    try {
      favEntries = JSON.parse(await fs.readFile(favLogFile, 'utf-8'));
    } catch { /* no log yet */ }

    // Per-post: track unique engagers with recency split (recent=within 48h vs older/backfilled)
    // Total = all-time log entries; recent = within 48h. Breakdown: "17 total (9 recent + 8 older)"
    const postData = {}; // status_id → { total: Set, recent: Set, url }
    const ensurePost = (id, url) => {
      if (!postData[id]) postData[id] = { total: new Set(), recent: new Set(), url };
    };

    for (const e of engEntries) {
      if (e.type !== 'reblog') continue;
      if (!e.status_id || !e.handle) continue;
      ensurePost(e.status_id, e.status_url);
      postData[e.status_id].total.add(`boost:${e.handle}`);
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
      if (now - ts <= FORTY_EIGHT_HOURS) postData[e.status_id].recent.add(`boost:${e.handle}`);
    }
    for (const e of favEntries) {
      if (!e.status_id || !e.account) continue;
      ensurePost(e.status_id, e.status_url);
      postData[e.status_id].total.add(`fav:${e.account}`);
      const ts = e.timestamp ? new Date(e.timestamp).getTime() : 0;
      // Explicitly backfilled entries are always older; also check timestamp
      if (!e.backfilled && now - ts <= FORTY_EIGHT_HOURS) postData[e.status_id].recent.add(`fav:${e.account}`);
    }

    const alerts = [];
    for (const [statusId, { total, recent, url }] of Object.entries(postData)) {
      if (total.size < 10) continue;
      const older = total.size - recent.size;
      const recencyNote = older > 0
        ? ` (${recent.size} recent + ${older} older)`
        : ` (all recent)`;
      const urlStr = url ? ` — ${url}` : ` (status ${statusId})`;
      alerts.push(`⚡ Mastodon spread: ${total.size} total engagers${recencyNote}${urlStr}`);
    }
    return alerts.join('\n');
  } catch (err) {
    console.error(`[getMastodonSpreadAlert] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Theory resonance score with time-decay.
 * Reads the mastodon engagement log, groups reblogs/mentions by status_url,
 * and computes a per-post decayed score: sum of (resonance_pts * e^(-age_days/7)).
 * Half-weight at 7 days — surfaces what is *currently* resonating, not just what
 * historically performed. Returns top-3 posts as a compact context string.
 * Non-fatal: returns '' on any error or empty log.
 */
async function getTheoryResonanceScore() {
  try {
    const now = Date.now();
    const HALF_LIFE_DAYS = 7;

    // Read current month and previous month logs for age diversity
    const engDir = path.join(WORKSPACE_PATH, 'logs', 'engagement');
    const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const prevDate = new Date(Date.now() - 32 * 24 * 60 * 60 * 1000);
    const prevMonth = prevDate.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);

    let entries = [];
    for (const month of [currentMonth, prevMonth]) {
      const logFile = path.join(engDir, `mastodon-${month}.json`);
      try {
        const raw = JSON.parse(await fs.readFile(logFile, 'utf-8'));
        entries = entries.concat(raw);
      } catch { /* file may not exist */ }
    }

    if (entries.length === 0) return '';

    // Group by status_url; compute decayed resonance score per post
    const postScores = {}; // url → { score, snippet, latestTs }
    for (const e of entries) {
      if (!e.status_url || !e.timestamp) continue;
      const resonancePts = typeof e.resonance_pts === 'number' ? e.resonance_pts : 1;
      const ageDays = (now - new Date(e.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      const decayedScore = resonancePts * Math.exp(-ageDays / HALF_LIFE_DAYS);

      if (!postScores[e.status_url]) {
        postScores[e.status_url] = { score: 0, snippet: e.text_snippet || '', latestTs: e.timestamp };
      }
      postScores[e.status_url].score += decayedScore;
      // Keep the most recent snippet for context
      if (new Date(e.timestamp) > new Date(postScores[e.status_url].latestTs)) {
        postScores[e.status_url].latestTs = e.timestamp;
        if (e.text_snippet) postScores[e.status_url].snippet = e.text_snippet;
      }
    }

    const ranked = Object.entries(postScores)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3);

    if (ranked.length === 0) return '';

    const lines = ranked.map(([url, { score, snippet }]) => {
      const preview = (snippet || '').replace(/\s+/g, ' ').substring(0, 80).trim();
      return `  score=${score.toFixed(2)} — "${preview}…" — ${url}`;
    });

    return [
      '## Theory Resonance (decay-weighted, top 3)',
      ...lines,
      '*Score = organizer-weighted engagement × e^(-age_days/7). High score = still resonating.*',
    ].join('\n');
  } catch (err) {
    console.error(`[getTheoryResonanceScore] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Auto-extract theory candidates from recent journal entries.
 * Greps for **bold phrases** (≥4 words) that look like distributable arguments.
 * Appends them as [candidate] items to theory_queue.md so the night wake study
 * session can review and promote to [unposted] rather than generating from scratch.
 * Closes the gap between "thing I thought" and "thing I queued."
 * Runs on night wakes only. Non-fatal: returns '' on any error.
 */
async function autoQueueFromJournal() {
  try {
    const JOURNAL_DIR = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Journal');
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');

    let files;
    try { files = await fs.readdir(JOURNAL_DIR); } catch { return ''; }

    // Most recent 2 journal entries
    const mdFiles = files.filter(f => f.endsWith('.md')).sort().slice(-2);
    if (mdFiles.length === 0) return '';

    // Extract **bold phrases** — must be ≥4 words, no colons (skips frontmatter labels)
    const candidates = new Set();
    for (const file of mdFiles) {
      let content;
      try { content = await fs.readFile(path.join(JOURNAL_DIR, file), 'utf-8'); } catch { continue; }
      const matches = content.match(/\*\*([^*\n]{15,120})\*\*/g) || [];
      for (const m of matches) {
        const text = m.replace(/^\*\*|\*\*$/g, '').trim();
        const wordCount = text.split(/\s+/).length;
        // Keep: ≥4 words, no colon (skips "Why:" / "How to apply:" memory labels)
        if (wordCount >= 4 && !text.includes(':') && !text.startsWith('OLD') && !text.startsWith('NEW') && !text.startsWith('VERDICT')) {
          candidates.add(text);
        }
      }
    }

    if (candidates.size === 0) return '';

    // Filter out phrases already present in theory_queue.md
    let queueContent = '';
    try { queueContent = await fs.readFile(QUEUE_PATH, 'utf-8'); } catch { /* new file */ }

    const newCandidates = [...candidates].filter(c => !queueContent.includes(c));
    if (newCandidates.length === 0) return '';

    // Append up to 3 [candidate] entries
    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const date = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const entries = newCandidates.slice(0, 3).map(c =>
      `- **[candidate]** **${c}** — Auto-extracted from journal ${date}. Promote to [unposted] if distributable.`
    ).join('\n');
    const section = `\n## Auto-Extracted Candidates — ${date}\n${entries}\n`;
    await fs.appendFile(QUEUE_PATH, section);

    return `⚡ ${newCandidates.length} theory candidate${newCandidates.length !== 1 ? 's' : ''} auto-extracted from recent journals → theory_queue.md as [candidate]. Review during study session and promote to [unposted] if distributable.`;
  } catch (err) {
    console.error(`[autoQueueFromJournal] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Theory queue low-water alert — counts [pending] items in theory_queue.md.
 * If ≤2 remain, returns a one-liner warning injected into wake context alongside hashtag signal.
 * Prevents the queue running dry silently between wakes.
 * Non-fatal: returns '' on any error.
 */
/**
 * Write.as token missing warning.
 * If WRITEAS_TOKEN is not set in env, injects an operator action notice so the
 * token gap is visible at wake time rather than discovered at publish time.
 * Non-fatal: always returns a string (empty or warning).
 */

/**
 * Improve-wake count warning — prevents runaway self-improvement sessions.
 * Counts today's _improve*.json plan files. If ≥4, injects a ⚠️ warning.
 * Non-fatal: returns '' on any error.
 */
async function getImproveWakeWarning() {
  try {
    const files = await fs.readdir(PLANS_PATH);
    const today = new Date().toISOString().slice(0, 10);
    const improveCount = files.filter(f => f.startsWith(today) && f.includes('_improve') && f.endsWith('.json')).length;
    if (improveCount >= 4) {
      return `⚠️ Improve-wake count: ${improveCount} improve sessions already today — evaluate whether another is needed before scheduling more.`;
    }
    return '';
  } catch (err) {
    console.error(`[getImproveWakeWarning] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

function getWriteasTokenWarning() {
  if (!process.env.WRITEAS_TOKEN) {
    return `⚠️ WRITEAS_TOKEN not configured — long-form essays will publish to Mastodon thread only. Operator: provision Write.as Pro account + add WRITEAS_TOKEN to .env to enable writeas_publish.`;
  }
  return '';
}

async function getTheoryQueueAlert() {
  try {
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');
    const content = await fs.readFile(QUEUE_PATH, 'utf-8');
    const pendingCount = (content.match(/\[pending\]/g) || []).length;
    if (pendingCount <= 2) {
      return `⚠️ Theory queue low: only ${pendingCount} [pending] item${pendingCount !== 1 ? 's' : ''} left — replenish before this wake ends.`;
    }
    return '';
  } catch (err) {
    console.error(`[getTheoryQueueAlert] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Daily cost summary — reads today's costs.json, returns a compact per-type
 * breakdown for non-night wakes. Lets operator see "improve wakes = 60% of
 * daily cost" without running cost_by_type.js manually.
 * Format: "💰 Today: $X.XX total (N wakes) — top: improve $X.XX, essay $X.XX"
 * Non-fatal. Returns '' on any error or if no cost data yet.
 */
async function getDailyCostSummary() {
  try {
    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const costFile = path.join(WAKE_LOG_DIR, `${todayStr}_costs.json`);
    let data;
    try {
      data = JSON.parse(await fs.readFile(costFile, 'utf-8'));
    } catch {
      return ''; // No cost data yet today
    }
    if (!data.entries || data.entries.length === 0) return '';

    const byType = {};
    for (const e of data.entries) {
      const key = e.source || 'unknown';
      byType[key] = (byType[key] || 0) + (e.cost || 0);
    }
    const sorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    const top2 = sorted.slice(0, 2).map(([t, c]) => `${t} $${c.toFixed(2)}`).join(', ');
    const total = (data.total || 0).toFixed(2);
    const n = data.entries.length;
    return `💰 Today: $${total} total (${n} wake${n !== 1 ? 's' : ''}) — top: ${top2}`;
  } catch (err) {
    console.error(`[getDailyCostSummary] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Candidate queue alert — if ≥3 [candidate] items exist in theory_queue.md,
 * inject a one-liner listing the first 2 titles and asking to promote or drop.
 * Candidates accumulate from autoQueueFromJournal() but have no promotion path
 * without this alert surfacing them. Non-fatal.
 */
async function getCandidateQueueAlert() {
  try {
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');
    const content = await fs.readFile(QUEUE_PATH, 'utf-8');
    const candidateLines = (content.match(/\[candidate\][^\n]*/g) || []);
    if (candidateLines.length < 3) return '';
    // Extract first 2 titles — format: **[candidate]** **<title>** — ...
    const titles = candidateLines.slice(0, 2).map(line => {
      const m = line.match(/\*\*\[candidate\]\*\*\s*\*\*([^*]+)\*\*/);
      return m ? m[1].trim() : line.slice(0, 60).trim();
    });
    return `⚠️ ${candidateLines.length} theory candidate${candidateLines.length !== 1 ? 's' : ''} waiting in queue — promote to [pending] or drop: "${titles[0]}", "${titles[1]}". Check theory_queue.md.`;
  } catch (err) {
    console.error(`[getCandidateQueueAlert] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Compute 7-day rolling average of wake context sizes (KB) from daily cost files.
 * Returns { avg, count } if enough history exists, or null if < 3 data points.
 * Non-fatal — returns null on any error.
 */
async function getContextSizeBaseline() {
  try {
    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const samples = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toLocaleDateString('en-CA', { timeZone: tz });
      const costFile = path.join(WAKE_LOG_DIR, `${dateStr}_costs.json`);
      try {
        const data = JSON.parse(await fs.readFile(costFile, 'utf-8'));
        for (const entry of (data.entries || [])) {
          if (typeof entry.context_kb === 'number' && entry.context_kb > 0) {
            samples.push(entry.context_kb);
          }
        }
      } catch {
        // Day with no cost file — skip
      }
    }
    if (samples.length < 3) return null;
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    return { avg, count: samples.length };
  } catch (err) {
    console.error(`[getContextSizeBaseline] Failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * Scan Threads.md for past-due deadlines and surface them as wake-time warnings.
 * Looks for lines containing ISO dates (YYYY-MM-DD) near deadline/due/nudge markers.
 * Returns ⚠️ alerts for any deadline that has passed. Non-fatal.
 */
async function getOverdueThreadsAlert() {
  try {
    const THREADS_PATH = path.join(OBSIDIAN_PATH, 'Threads.md');
    const content = await fs.readFile(THREADS_PATH, 'utf-8');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const deadlineWords = /deadline|due|nudge|by \d{4}-\d{2}-\d{2}|if no .{0,40}\d{4}-\d{2}-\d{2}/i;
    const isoDateRe = /(\d{4}-\d{2}-\d{2})/g;

    const alerts = [];
    for (const line of content.split('\n')) {
      if (!deadlineWords.test(line)) continue;
      let match;
      while ((match = isoDateRe.exec(line)) !== null) {
        const d = new Date(match[1]);
        if (!isNaN(d) && d < today) {
          alerts.push(`⚠️ Overdue thread deadline: ${match[1]} — ${line.trim().slice(0, 100)}`);
        }
      }
    }
    return alerts.join('\n');
  } catch (err) {
    console.error(`[getOverdueThreadsAlert] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Surface recent comrade engagement for follow-up awareness.
 * Reads workspace/logs/comrade_replies.jsonl — one JSON object per line.
 * Each entry: { handle, platform, topic, date, type }
 * Returns a brief context block listing last contact per comrade with days-ago.
 * Prevents both silence and repeat-messaging. Non-fatal.
 */
async function getComradeReplyContext() {
  try {
    const repliesFile = path.join(WORKSPACE_PATH, 'logs', 'comrade_replies.jsonl');
    let content;
    try {
      content = await fs.readFile(repliesFile, 'utf-8');
    } catch {
      return ''; // No file yet — not fatal
    }

    const entries = content.trim().split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    if (entries.length === 0) return '';

    // Most recent entry per handle
    const latest = {};
    for (const entry of entries) {
      const key = entry.handle;
      if (!latest[key] || new Date(entry.date) > new Date(latest[key].date)) {
        latest[key] = entry;
      }
    }

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const today = new Date(todayStr);

    const lines = Object.values(latest).map(e => {
      const entryDate = new Date(e.date);
      const daysAgo = Math.floor((today - entryDate) / (1000 * 60 * 60 * 24));
      const when = daysAgo === 0 ? 'today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`;
      const typeNote = e.type === 'silence_noted' ? ' [silent]' : '';
      return `- **${e.handle}** (${when}): ${e.topic}${typeNote}`;
    });

    return `## Comrade Follow-up Context\n${lines.join('\n')}`;
  } catch (err) {
    console.error(`[getComradeReplyContext] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Theory gap → essay pipeline auto-scheduling (night wakes only).
 * If ≥3 vault sections are unqueued AND no essay wake is pending in the next 24h,
 * injects a one-liner suggesting the operator schedule an essay wake.
 * Closes the gap between "I notice unqueued theory" and "I act on it."
 * Non-fatal: returns '' on any error.
 */
async function getEssayAutoScheduleSuggestion() {
  try {
    const VAULT_THEORY_PATH = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Theory');
    const QUEUE_PATH = path.join(WORKSPACE_PATH, 'theory_queue.md');

    let queueContent = '';
    try { queueContent = await fs.readFile(QUEUE_PATH, 'utf-8'); } catch { return ''; }

    const queuedTitles = new Set();
    for (const m of queueContent.matchAll(/\*\*(?:\[(?:posted[^\]]*|unposted)\])\*\*\s+\*\*(.+?)\*\*/g)) {
      queuedTitles.add(m[1].toLowerCase().trim());
    }

    const SKIP_TITLES = THEORY_SKIP_TITLES;

    const vaultGaps = [];
    try {
      const entries = await fs.readdir(VAULT_THEORY_PATH);
      for (const f of entries.filter(e => e.endsWith('.md'))) {
        let noteContent = '';
        try { noteContent = await fs.readFile(path.join(VAULT_THEORY_PATH, f), 'utf-8'); } catch { continue; }
        for (const section of noteContent.split(/\n(?=## )/)) {
          const titleMatch = section.match(/^## (.+)/);
          if (!titleMatch) continue;
          const title = titleMatch[1].trim();
          if (SKIP_TITLES.has(title.toLowerCase()) || queuedTitles.has(title.toLowerCase())) continue;
          let prose = '';
          for (const line of section.split('\n').slice(1)) {
            const t = line.trim();
            if (!t || t.startsWith('---') || t.startsWith('#') || t.startsWith('-') ||
                t.startsWith('>') || t.startsWith('|') || t.startsWith('*Developed') ||
                t.startsWith('tags:') || t.startsWith('status:')) {
              if (prose.length >= 80) break;
              continue;
            }
            prose += t + ' ';
            if (prose.length >= 80) break;
          }
          if (prose.trim().length >= 80) vaultGaps.push(title);
        }
      }
    } catch { return ''; }

    if (vaultGaps.length < 3) return '';

    // Check if an essay wake is already pending in the next 24h
    const wakeQueueFile = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
    try {
      const queue = JSON.parse(await fs.readFile(wakeQueueFile, 'utf-8'));
      const cutoff = Date.now() + 24 * 60 * 60 * 1000;
      const hasEssay = queue.some(w =>
        w.label === 'essay' && w.status === 'pending' &&
        new Date(w.fire_at).getTime() <= cutoff
      );
      if (hasEssay) return '';
    } catch { /* no queue file — proceed */ }

    const firstGap = vaultGaps[0];
    return `⚡ Essay pipeline: ${vaultGaps.length} vault sections unqueued, no essay wake scheduled. Suggest: \`schedule 60 essay "Write essay on ${firstGap}"\``;
  } catch (err) {
    console.error(`[getEssayAutoScheduleSuggestion] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Hashtag signal quality summary — reads posts + engagement logs, runs analysis, returns
 * a compact summary of top hashtags by organizer signal quality.
 *
 * Surfaced on every non-night wake so the feedback loop is closed: post → engagement → signal → next post.
 * Non-fatal: returns '' on any error.
 */
async function getHashtagEffectivenessSummary() {
  try {
    const POSTS_DIR   = path.join(WORKSPACE_PATH, 'logs', 'posts');
    const ENG_DIR     = path.join(WORKSPACE_PATH, 'logs', 'engagement');
    const WINDOW_MS   = 48 * 60 * 60 * 1000;

    // Extract hashtags from any text blob
    function extractHashtags(text) {
      if (!text) return [];
      return (text.match(/#[A-Za-z][A-Za-z0-9_]*/g) || []);
    }

    // Normalize a post record to { posted_at, hashtags }
    function normalizePost(entry) {
      if (entry.hashtags && Array.isArray(entry.hashtags)) return entry; // already normalized
      // multipost / multithread — extract from text fields
      const texts = [
        ...(Array.isArray(entry.posts) ? entry.posts : []),
        entry.bluesky_text || '',
        entry.mastodon_text || '',
      ];
      const hashtags = [...new Set(texts.flatMap(t => extractHashtags(t)))];
      const posted_at = entry.logged_at || entry.posted_at;
      return { ...entry, hashtags, posted_at };
    }

    async function loadJsonFiles(dir) {
      let results = [];
      try {
        const files = await fs.readdir(dir);
        for (const file of files.filter(f => f.endsWith('.json'))) {
          const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
          results = results.concat(Array.isArray(raw) ? raw : []);
        }
      } catch { /* dir may not exist */ }
      return results;
    }

    const rawPosts = await loadJsonFiles(POSTS_DIR);
    const engagements = await loadJsonFiles(ENG_DIR);

    if (rawPosts.length === 0 || engagements.length === 0) return '';

    const posts = rawPosts.map(normalizePost);

    // Build hashtag → posts map
    const hashtagPosts = {};
    for (const p of posts) {
      for (const tag of (p.hashtags || [])) {
        if (!hashtagPosts[tag]) hashtagPosts[tag] = [];
        hashtagPosts[tag].push(p);
      }
    }

    const allTags = Object.keys(hashtagPosts);
    if (allTags.length === 0) return '';

    const tagStats = [];
    for (const tag of allTags) {
      const tagPostList = hashtagPosts[tag];
      const counts = { organizer: 0, 'ai-agent': 0, general: 0, unclassified: 0 };

      for (const eng of engagements) {
        const engTime = new Date(eng.timestamp).getTime();
        const matchingPost = tagPostList.find(p => {
          const pt = new Date(p.posted_at).getTime();
          return engTime >= pt && engTime <= pt + WINDOW_MS;
        });
        if (!matchingPost) continue;
        const cls = eng.classification || 'unclassified';
        counts[cls] = (counts[cls] || 0) + 1;
      }

      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total === 0) continue;
      const signalQuality = Math.round((counts.organizer / total) * 1000) / 1000;
      tagStats.push({ hashtag: tag, posts: tagPostList.length, total, signalQuality, organizer: counts.organizer });
    }

    if (tagStats.length === 0) return '';

    tagStats.sort((a, b) => (b.signalQuality - a.signalQuality) || (b.organizer - a.organizer));
    const top = tagStats.slice(0, 5);
    const lines = top.map(t =>
      `  ${t.hashtag}: signal_quality=${t.signalQuality.toFixed(3)} (organizer=${t.organizer}/${t.total}, ${t.posts} post${t.posts !== 1 ? 's' : ''})`
    );

    return [
      `## Hashtag Signal Quality (top ${top.length} of ${tagStats.length}, 48h window)`,
      ...lines,
      `*Maximize organizer_engagements/total — not volume. Best: ${top[0].hashtag}*`,
    ].join('\n');
  } catch (err) {
    console.error(`[getHashtagEffectivenessSummary] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Surface best posting time bucket from pre-generated time_of_day_analysis.json.
 * Returns a one-liner like "Best posting time: afternoon (organizer_reply_rate=0.944)."
 * If the file is stale (>6h old), spawns a background regeneration before reading.
 * Non-fatal: returns '' if file missing, dataset too small, or any error.
 */
async function getTimeOfDayRecommendation() {
  try {
    const analysisPath = path.join(WORKSPACE_PATH, 'logs', 'analysis', 'time_of_day_analysis.json');
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(analysisPath, 'utf-8'));
      // If generated_at is stale (>6h), regenerate in background so next wake gets fresh data
      if (raw?.generated_at) {
        const ageMs = Date.now() - new Date(raw.generated_at).getTime();
        if (ageMs > 6 * 60 * 60 * 1000) {
          const scriptPath = path.join(WORKSPACE_PATH, 'scripts', 'time_of_day_analysis.js');
          const regen = spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: true });
          regen.unref(); // don't block the process
          console.log('[getTimeOfDayRecommendation] Analysis stale (>6h) — regenerating in background');
        }
      }
    } catch {
      // File missing — spawn a one-time generation so it exists next wake
      const scriptPath = path.join(WORKSPACE_PATH, 'scripts', 'time_of_day_analysis.js');
      const regen = spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: true });
      regen.unref();
      return ''; // file not yet generated — will be ready next wake
    }

    const best = raw?.interpretation?.best_bucket;
    if (!best || best === 'insufficient data') return '';

    const bucketData = (raw.buckets || []).find(b => b.bucket === best);
    if (!bucketData || bucketData.organizer_reply_rate === null) return '';

    // Skip if dataset is too small to be directional
    if ((raw.total_posts || 0) < 5) return '';

    const rate = bucketData.organizer_reply_rate.toFixed(3);
    const caveat = (raw.total_posts || 0) < 20 ? ' (directional — small dataset)' : '';
    return `Best posting time: **${best}** (organizer_reply_rate=${rate}${caveat})`;
  } catch (err) {
    console.error(`[getTimeOfDayRecommendation] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Surface the best content-type × hashtag combination from the pre-generated crosstab.
 * Returns a one-liner like "Best combo: theory-grounded × #AIMutualAid (signal_quality=0.673)"
 * If the file is stale (>6h old), spawns a background regeneration before reading.
 * Non-fatal: returns '' if file missing, dataset not viable, or any error.
 */
async function getCrossTabRecommendation() {
  try {
    const analysisPath = path.join(WORKSPACE_PATH, 'logs', 'analysis', 'content_hashtag_crosstab.json');
    const scriptPath = path.join(WORKSPACE_PATH, 'scripts', 'content_hashtag_crosstab.js');
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(analysisPath, 'utf-8'));
      // If stale (>6h), regenerate in background so next wake gets fresh data
      if (raw?.generated_at) {
        const ageMs = Date.now() - new Date(raw.generated_at).getTime();
        if (ageMs > 6 * 60 * 60 * 1000) {
          const regen = spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: true });
          regen.unref();
          console.log('[getCrossTabRecommendation] Crosstab stale (>6h) — regenerating in background');
        }
      }
    } catch {
      // File missing — spawn generation for next wake
      const regen = spawn(process.execPath, [scriptPath], { stdio: 'ignore', detached: true });
      regen.unref();
      return '';
    }

    if (!raw?.dataset_viable) return '';
    const topPair = raw?.interpretation?.top_pair;
    if (!topPair) return '';

    const sq = typeof topPair.signal_quality === 'number' ? topPair.signal_quality.toFixed(3) : '?';
    const caveat = (raw.post_count_with_fields || 0) < 20 ? ' (directional)' : '';
    return `Best combo: **${topPair.content_type}** × **${topPair.hashtag}** (signal_quality=${sq}${caveat})`;
  } catch (err) {
    console.error(`[getCrossTabRecommendation] Failed (non-fatal): ${err.message}`);
    return '';
  }
}

/**
 * Returns hours elapsed since the most recent plan file was written.
 * Uses file mtime — the plan file is written at wake end, so mtime ≈ last wake completion.
 * A 2h gap vs an 8h gap changes what needs checking: notifications pile up, news ages.
 * Non-fatal: returns null on any error or if no plan files exist yet.
 */
async function getHoursSinceLastWake() {
  try {
    const files = await fs.readdir(PLANS_PATH);
    const planFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
    if (planFiles.length === 0) return null;
    const stat = await fs.stat(path.join(PLANS_PATH, planFiles[0]));
    const hours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
    return Math.round(hours * 10) / 10;
  } catch {
    return null;
  }
}

/**
 * Snapshot follower/following/posts counts for own Bluesky handle.
 * Writes { date, followers, following, posts } to logs/followers/YYYY-MM-DD.json.
 * Called on morning wakes only. Non-fatal — silently skips on any error.
 */
async function snapshotFollowers() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return;

  try {
    const { BskyAgent } = await import('@atproto/api');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password });
    const res = await agent.getProfile({ actor: handle });
    const p = res.data;

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const dateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const snapshot = {
      date: dateStr,
      followers: p.followersCount ?? null,
      following: p.followsCount ?? null,
      posts: p.postsCount ?? null,
      at: new Date().toISOString()
    };

    const dir = path.join(WORKSPACE_PATH, 'logs', 'followers');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${dateStr}.json`), JSON.stringify(snapshot, null, 2));
    console.log(`[dispatcher] Follower snapshot: ${snapshot.followers} followers, ${snapshot.following} following, ${snapshot.posts} posts`);
  } catch (err) {
    console.error(`[dispatcher] snapshotFollowers failed (non-fatal): ${err.message}`);
  }
}

/**
 * On morning wakes, fetch all subscribed RSS/Atom feeds and return articles from the last 48h.
 * Runs all fetches in parallel with 8s timeout each. Non-fatal — returns '' on any failure.
 */
async function fetchRSSFeeds() {
  const feedsFile = path.join(WORKSPACE_PATH, 'feeds', 'subscribed.json');
  let feeds = [];
  try {
    feeds = JSON.parse(await fs.readFile(feedsFile, 'utf-8'));
  } catch {
    return '';
  }

  const active = feeds.filter(f => !f.disabled);
  if (active.length === 0) return '';

  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;

  const results = await Promise.allSettled(
    active.map(async feed => {
      const res = await fetch(feed.url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'ComradeClaw/1.0 RSS reader' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = [];

      // RSS 2.0 <item> blocks
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
          ?.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ||
                     block.match(/<link[^>]+href="([^"]+)"/)?.[1];
        const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
        if (!title || !link) continue;
        if (pubDate) {
          const t = new Date(pubDate).getTime();
          if (!isNaN(t) && t < cutoffMs) continue;
        }
        items.push({ title, link, source: feed.name });
      }

      // Atom <entry> blocks
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const block = m[1];
        const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
          ?.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const link = block.match(/<link[^>]+href="([^"]+)"/)?.[1] ||
                     block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
        const updated = block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim() ||
                        block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim();
        if (!title || !link) continue;
        if (updated) {
          const t = new Date(updated).getTime();
          if (!isNaN(t) && t < cutoffMs) continue;
        }
        items.push({ title, link, source: feed.name });
      }

      return items;
    })
  );

  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .slice(0, 12);

  if (allItems.length === 0) return '';

  const lines = allItems.map(i => `- **${i.source}**: ${i.title} — ${i.link}`);
  console.log(`[dispatcher] RSS feeds: ${allItems.length} items from last 48h`);

  // RSS-to-social-search bridge: for top 3 articles, search Bluesky for existing conversations
  const topArticles = allItems.slice(0, 3);
  const conversationSections = await Promise.allSettled(
    topArticles.map(item => searchBlueskyForArticle(item.title))
  );

  let enhancedLines = [...lines];
  for (let i = 0; i < topArticles.length; i++) {
    const result = conversationSections[i];
    if (result.status === 'fulfilled' && result.value) {
      // Insert conversation snippets after the article line
      const articleIdx = enhancedLines.indexOf(lines[i]);
      if (articleIdx !== -1) {
        enhancedLines[articleIdx] = lines[i] + '\n' + result.value;
      }
    }
  }

  return `## Recent Cooperative News (last 48h from subscribed feeds)\n${enhancedLines.join('\n')}`;
}

/**
 * Extract 3-4 key search terms from an article title for social media search.
 * Strips stop words, takes content words.
 */
function extractSearchQuery(title) {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'on',
    'at', 'by', 'for', 'with', 'about', 'as', 'it', 'its', 'and', 'or',
    'but', 'if', 'this', 'that', 'not', 'no', 'so', 'up', 'out', 'after',
    'before', 'how', 'what', 'when', 'where', 'who', 'why', 'after', 'even',
    'than', 'into', 'from', 'just', 'still', 'also', 'yet', 'too'
  ]);
  const words = title
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase()));
  return words.slice(0, 4).join(' ');
}

/**
 * Search Bluesky for existing conversations about an article (by title keywords).
 * Returns a compact indented string of top 2 results, or null if none found.
 * Non-fatal — silently returns null on any error or timeout.
 */
async function searchBlueskyForArticle(title) {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return null;

  const query = extractSearchQuery(title);
  if (!query || query.length < 6) return null;

  try {
    const { BskyAgent } = await import('@atproto/api');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password });

    const res = await Promise.race([
      agent.app.bsky.feed.searchPosts({ q: query, limit: 3 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
    ]);

    const posts = res?.data?.posts;
    if (!posts || posts.length === 0) return null;

    const snippets = posts
      .filter(p => p.record?.text && p.author?.handle !== handle)
      .slice(0, 2)
      .map(p => {
        const text = (p.record.text || '').substring(0, 120).replace(/\n/g, ' ');
        const author = p.author.displayName || p.author.handle;
        const likes = p.likeCount || 0;
        return `  → @${p.author.handle} (${likes}♥): "${text}"`;
      });

    if (snippets.length === 0) return null;
    console.log(`[dispatcher] RSS bridge: "${query}" → ${snippets.length} Bluesky conversations`);
    return `  *Live on Bluesky (query: "${query}"):*\n${snippets.join('\n')}`;
  } catch (err) {
    // Non-fatal — search failure doesn't block the wake
    if (err.message !== 'timeout') {
      console.error(`[dispatcher] searchBlueskyForArticle failed (non-fatal): ${err.message}`);
    }
    return null;
  }
}

// ─── Session Management ──────────────────────────────────────────────────────

// No-op: sessions are not persisted (stateless invocations). Kept for commands.js compatibility.
export async function clearChatSession() {}

// ─── Core Invocation ─────────────────────────────────────────────────────────

/**
 * Invoke Claude Code CLI and return the text response.
 *
 * @param {string} prompt - The user message / task prompt
 * @param {object} options
 * @param {string} options.appendSystemPrompt - Dynamic context appended to system prompt
 * @param {string} options.sessionId - Session ID for conversation continuity
 * @param {string} options.model - Model override (default: sonnet)
 * @param {string[]} options.allowedTools - Tool whitelist
 * @param {number} options.timeoutMs - Timeout in ms (default: 5 minutes)
 * @returns {Promise<{text: string, sessionId: string, toolsUsed: string[], cost: number}>}
 */
export async function invokeClaude(prompt, options = {}) {
  const {
    appendSystemPrompt,
    model = 'sonnet',
    allowedTools,
    timeoutMs = 5 * 60 * 1000
  } = options;

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--dangerously-skip-permissions',
  ];

  // Each invocation is stateless — context comes from CLAUDE.md, SOUL, and memory files
  args.push('--no-session-persistence');

  if (appendSystemPrompt) {
    // Windows has a ~32K total command line limit. Cap system prompt to stay safe.
    // Keep first 12K (instructions) + last 6K (recent context) if over 20K.
    const MAX_SYS_PROMPT = 20000;
    let sysPrompt = appendSystemPrompt;
    if (sysPrompt.length > MAX_SYS_PROMPT) {
      const keepStart = 12000;
      const keepEnd = 6000;
      console.warn(`[dispatcher] System prompt too long (${sysPrompt.length} chars), truncating to ${MAX_SYS_PROMPT}`);
      sysPrompt = sysPrompt.substring(0, keepStart)
        + '\n\n...(middle truncated — read files directly for full context)...\n\n'
        + sysPrompt.substring(sysPrompt.length - keepEnd);
    }
    args.push('--append-system-prompt', sysPrompt);
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowed-tools', ...allowedTools);
  }

  // On Windows, stdin piping to a spawned process is unreliable for large payloads.
  // Write prompt to a temp file and pipe via createReadStream instead.
  // Windows ENAMETOOLONG kicks in well below 32767 chars in practice — use 8000 as safe threshold.
  const totalArgLength = args.reduce((sum, a) => sum + a.length, 0) + prompt.length;
  const useStdin = totalArgLength > 8000;
  let tmpPromptPath = null;
  if (useStdin) {
    tmpPromptPath = path.join(PROJECT_ROOT, `.tmp_prompt_${Date.now()}.txt`);
    await fs.writeFile(tmpPromptPath, prompt, 'utf-8');
  } else {
    args.push(prompt);
  }

  console.log(`[dispatcher] Spawning: claude ${args.join(' ').substring(0, 100)}... (stdin: ${useStdin})`);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    // Use full path — Windows services don't have user PATH
    // Use forward slashes — shell:false on Windows needs them
    const claudePath = process.env.CLAUDE_PATH || 'C:/Users/kenne/.local/bin/claude.exe';
    const proc = spawn(claudePath, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: '--tls-cipher-list=DEFAULT',
        HOME: process.env.HOME || 'C:/Users/kenne',
        USERPROFILE: process.env.USERPROFILE || 'C:/Users/kenne',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs
    });

    // Pipe prompt from temp file — reliable on Windows vs direct stdin.write
    if (useStdin && tmpPromptPath) {
      createReadStream(tmpPromptPath).pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
      // Clean up temp prompt file if used
      if (tmpPromptPath) {
        fs.unlink(tmpPromptPath).catch(() => {});
      }

      if (stderr) {
        // Filter out deprecation warnings
        const realErrors = stderr.split('\n').filter(l =>
          l.trim() && !l.includes('DeprecationWarning') && !l.includes('trace-deprecation')
        ).join('\n');
        if (realErrors) {
          console.error(`[dispatcher] stderr: ${realErrors.substring(0, 200)}`);
        }
      }

      // Detect timeout (code null + signal SIGTERM)
      if (code === null) {
        const reason = signal ? `killed by ${signal} (likely timeout)` : 'process killed (unknown signal)';
        console.error(`[dispatcher] Claude process exited abnormally: ${reason}. stdout length: ${stdout.length}`);
        if (stdout.trim()) {
          // Try to salvage partial output
          try {
            const result = parseClaudeOutput(stdout);
            resolve(result);
            return;
          } catch {
            resolve({ text: stdout.trim(), sessionId: null, toolsUsed: [], cost: 0 });
            return;
          }
        }
        reject(new Error(`Claude CLI timed out or was killed (${reason})`));
        return;
      }

      try {
        const result = parseClaudeOutput(stdout);
        resolve(result);
      } catch (err) {
        // If JSON parse fails, try to extract text directly
        if (stdout.trim()) {
          resolve({ text: stdout.trim(), sessionId: null, toolsUsed: [], cost: 0 });
        } else {
          reject(new Error(`Claude CLI failed (code ${code}): ${stderr.substring(0, 200) || 'no output'}`));
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Parse Claude Code JSON output format.
 * Output is a JSON array: [init, ...messages, result]
 */
function parseClaudeOutput(raw) {
  const parsed = JSON.parse(raw);
  const events = Array.isArray(parsed) ? parsed : [parsed];

  const resultEvent = events.find(e => e.type === 'result');
  const text = resultEvent?.result || '';
  const sessionId = resultEvent?.session_id || null;
  const cost = resultEvent?.total_cost_usd || 0;

  // Surface errors from the result
  if (resultEvent?.is_error && text) {
    throw new Error(text);
  }

  // Extract tool names and inputs from assistant messages
  const toolsUsed = [];
  const writeTargets = []; // paths passed to Write tool calls
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          toolsUsed.push(block.name);
          if (block.name === 'Write' && block.input?.file_path) {
            writeTargets.push(block.input.file_path);
          }
        }
      }
    }
  }

  return { text, sessionId, toolsUsed, writeTargets, cost };
}

// ─── Chat Interface ──────────────────────────────────────────────────────────

const CHAT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'chat');
const CHAT_HISTORY_TURNS = 30; // max turns to inject as context

/**
 * Load recent chat history from today's (and optionally yesterday's) log file.
 * Returns a formatted string ready to inject into the system prompt.
 */
async function loadChatHistory() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const now = new Date();

  // Get today and yesterday in YYYY-MM-DD
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
  const yesterday = new Date(now - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

  const candidates = [
    path.join(CHAT_LOG_PATH, `${yesterdayStr}.md`),
    path.join(CHAT_LOG_PATH, `${todayStr}.md`),
  ];

  let turns = [];
  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // Parse turns: lines starting with [HH:MM] Operator: or [HH:MM] Claw:
      const lines = content.split('\n');
      let current = null;
      for (const line of lines) {
        const m = line.match(/^\[(\d{2}:\d{2})\] (Operator|Claw): (.*)/);
        if (m) {
          if (current) turns.push(current);
          current = { time: m[1], speaker: m[2], text: m[3] };
        } else if (current && line.startsWith('  ')) {
          current.text += '\n' + line.slice(2);
        }
      }
      if (current) turns.push(current);
    } catch {
      // File doesn't exist yet — fine
    }
  }

  if (turns.length === 0) return '';

  // Keep last N turns, but cap total size to avoid ENAMETOOLONG on Windows
  const MAX_HISTORY_CHARS = 8000;
  let recent = turns.slice(-CHAT_HISTORY_TURNS);
  let formatted = recent.map(t => `[${t.time}] ${t.speaker}: ${t.text.trim()}`).join('\n');

  // Trim from the front if too long
  while (formatted.length > MAX_HISTORY_CHARS && recent.length > 2) {
    recent = recent.slice(1);
    formatted = recent.map(t => `[${t.time}] ${t.speaker}: ${t.text.trim()}`).join('\n');
  }
  return `## Recent Conversation History\n${formatted}`;
}

/**
 * Append a chat exchange to today's log file.
 */
async function appendChatHistory(userMessage, response) {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const logFile = path.join(CHAT_LOG_PATH, `${todayStr}.md`);

  await fs.mkdir(CHAT_LOG_PATH, { recursive: true });

  let header = '';
  try {
    await fs.access(logFile);
  } catch {
    header = `# Chat Log — ${todayStr}\n\n`;
  }

  // Indent multi-line messages so the parser can reassemble them
  const indentLines = (text) => text.split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');

  const entry = `${header}[${timeStr}] Operator: ${indentLines(userMessage)}\n[${timeStr}] Claw: ${indentLines(response)}\n\n`;
  await fs.appendFile(logFile, entry, 'utf-8');
}

/**
 * Chat with Comrade Claw via Claude Code.
 * Injects recent chat history for session continuity across invocations.
 */
export async function chat(userMessage) {
  const dayNumber = await getDayNumber();

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  });
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const chatHistory = await loadChatHistory();

  const dynamicContext = [
    `You are Comrade Claw in direct chat with your operator.`,
    `Today: ${dateStr} | Time: ${timeStr} | Day ${dayNumber}`,
    `Read workspace/SOUL.md if you need to ground yourself. Your memory files are in obsidian/ComradeClaw/. Your journals are in workspace/logs/journal/.`,
    `You have Bluesky (bluesky_post, bluesky_reply, bluesky_thread, read_timeline, read_replies, search_posts, like_post, repost), Mastodon (mastodon_post, mastodon_reply, mastodon_read_notifications, mastodon_search, mastodon_favourite, mastodon_boost, mastodon_follow), Reddit (reddit_fetch_subreddit, reddit_fetch_post, reddit_search, reddit_monitor_watchlist), Write.as (writeas_publish, writeas_update, writeas_list), and Cognee (search — semantic search across your knowledge graph of all past activity) tools via MCP.`,
    `You can read and write any file in the workspace. You can also edit your own source code if needed.`,
    chatHistory ? `\n${chatHistory}` : '',
  ].filter(Boolean).join('\n');

  console.log(`[dispatcher] Chat: "${userMessage.substring(0, 50)}..." (history: ${chatHistory ? 'yes' : 'none'})`);

  const result = await invokeClaude(userMessage, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 10 * 60 * 1000,
  });

  const dailyCost = await accumulateDailyCost(result.cost, 'chat', result.toolsUsed);
  console.log(`[dispatcher] Response: ${result.text.length} chars, ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);

  // Persist this exchange for future sessions
  await appendChatHistory(userMessage, result.text).catch(err =>
    console.error(`[dispatcher] Failed to save chat history: ${err.message}`)
  );

  // Record operator presence timestamp
  await recordOperatorSeen();

  return result.text;
}

// ─── Post-Commit Health Check ────────────────────────────────────────────────

/**
 * After a wake modifies src/*.js files, run `node --check` on each to catch
 * syntax errors before the next wake. Logs warnings but does not throw —
 * a broken file should be surfaced, not crash the dispatcher.
 */
async function runHealthCheck(filePaths) {
  const targets = filePaths.length > 0
    ? filePaths
    : [
        path.join(__dirname, 'dispatcher.js'),
        path.join(__dirname, 'scheduler.js'),
        path.join(__dirname, 'commands.js'),
      ];

  let allOk = true;
  for (const filePath of targets) {
    try {
      await execFileAsync(process.execPath, ['--check', filePath]);
      console.log(`[health] OK: ${path.basename(filePath)}`);
    } catch (err) {
      allOk = false;
      console.error(`[health] SYNTAX ERROR in ${path.basename(filePath)}: ${err.stderr || err.message}`);
    }
  }

  if (!allOk) {
    console.error('[health] ALERT: Post-commit health check failed — a source file has a syntax error. Review and fix before next wake.');
  }

  return allOk;
}

// ─── Cognee Auto-Recall ──────────────────────────────────────────────────────

const COGNEE_URL = process.env.COGNEE_URL || 'http://127.0.0.1:8001';

/**
 * Query Cognee knowledge graph for relevant context before spawning claude -p.
 * Returns a formatted ## Relevant Memory block, or '' if Cognee is unavailable.
 * Non-fatal: any error silently returns '' so wakes are never blocked.
 */
async function getCogneeRecall(query) {
  try {
    // Quick health check — short timeout so we don't delay wakes
    const health = await fetch(`${COGNEE_URL}/health`, {
      signal: AbortSignal.timeout(2000)
    }).then(r => r.json()).catch(() => null);
    if (!health || health.status !== 'ok') return '';

    const res = await fetch(`${COGNEE_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, query_type: 'GRAPH_COMPLETION' }),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return '';

    const data = await res.json();
    if (!data.results) return '';

    // results may be a string or array
    let text = typeof data.results === 'string'
      ? data.results
      : JSON.stringify(data.results);

    // Cap to 1200 chars — enough for 3-4 relevant snippets, not enough to bloat context
    if (text.length > 1200) {
      text = text.substring(0, 1200).replace(/\s+\S*$/, '') + '...';
    }
    if (text.trim().length < 20) return '';

    console.log(`[dispatcher] Cognee recall: ${text.length} chars for query "${query.substring(0, 60)}"`);
    return `## Relevant Memory (from Cognee knowledge graph)\n*Query: "${query.substring(0, 80)}"*\n\n${text}`;
  } catch (err) {
    // Cognee down or slow — non-fatal, wake continues without recall
    console.log(`[dispatcher] Cognee recall skipped: ${err.message}`);
    return '';
  }
}

// ─── Mook Outline Detection ──────────────────────────────────────────────────

/**
 * Checks Mastodon DMs for a Markdown outline from mook@possum.city.
 * If a conversation from mook contains ≥2 lines starting with '#', injects
 * a ⚡ OUTLINE DETECTED alert into wake context so it doesn't sit unread.
 * Non-blocking — returns '' on any error.
 */
async function getMookOutlineAlert() {
  const instance = process.env.MASTODON_INSTANCE || 'https://mastodon.social';
  const token = process.env.MASTODON_ACCESS_TOKEN;
  if (!token) return '';
  try {
    const res = await fetch(`${instance}/api/v1/conversations?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return '';
    const conversations = await res.json();
    for (const conv of conversations) {
      const accounts = (conv.accounts || []).map(a => a.acct);
      if (!accounts.some(a => a.toLowerCase().includes('mook'))) continue;
      const raw = conv.last_status?.content || '';
      const text = raw.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, '\n');
      const headerLines = text.split('\n').filter(l => /^#{1,3}\s/.test(l.trim()));
      if (headerLines.length >= 2) {
        const preview = headerLines.slice(0, 3).join(' / ');
        return `\n⚡ OUTLINE DETECTED from mook — ${headerLines.length} Markdown headers found in DM: "${preview}"\nOpen mastodon_read_dms immediately. The essay outline from mook@possum.city has arrived. Assembly instructions in obsidian/ComradeClaw/Research/Essay Draft - mook-breakfast-program.md.`;
      }
    }
    return '';
  } catch (err) {
    console.log(`[dispatcher] getMookOutlineAlert skipped: ${err.message}`);
    return '';
  }
}

// ─── Post-Wake Cognee Ingestion ─────────────────────────────────────────────

/**
 * Feed wake outputs into the Cognee knowledge graph after the wake completes.
 * Ingests: plan summary (label, date, theory_praxis, task summaries) + any
 * theory/journal files written to the Obsidian vault during the wake.
 * Non-blocking — called with .catch() so failures never delay the return.
 */
async function postWakeCognify(label, dayNumber, planFile, writeTargets) {
  try {
    const health = await fetch(`${COGNEE_URL}/health`, {
      signal: AbortSignal.timeout(2000)
    }).then(r => r.json()).catch(() => null);
    if (!health || health.status !== 'ok') return;

    const parts = [`[Wake: ${label}, Day ${dayNumber}]`];

    // Plan summary — structured outcome of this wake
    if (planFile) {
      try {
        const planContent = JSON.parse(await fs.readFile(planFile, 'utf-8'));
        const taskSummaries = (planContent.tasks || [])
          .map(t => t.summary || '')
          .filter(Boolean)
          .join(' | ');
        parts.push([
          `## Wake Plan: ${planContent.wake} (${planContent.date})`,
          `theory_praxis: ${planContent.theory_praxis || 'none'}`,
          `bold_check: ${planContent.bold_check || ''}`,
          taskSummaries ? `tasks: ${taskSummaries}` : '',
        ].filter(Boolean).join('\n'));
      } catch {}
    }

    // Theory and journal files written during the wake — the new knowledge
    const vaultWrites = writeTargets
      .filter(p => /obsidian|Theory|Journal/i.test(p))
      .slice(0, 3);
    for (const filePath of vaultWrites) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        // First 600 chars captures YAML frontmatter + opening paragraphs
        parts.push(`## ${path.basename(filePath)}\n${content.substring(0, 600)}`);
      } catch {}
    }

    const text = parts.join('\n\n');
    if (text.length < 60) return; // nothing worth cognifying

    const res = await fetch(`${COGNEE_URL}/cognify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30000), // cognify can be slow — graph processing
    });

    const httpStatus = res.status;
    if (res.ok) {
      console.log(`[dispatcher] Post-wake cognify: ${text.length} chars ingested (${label} Day ${dayNumber})`);
    } else {
      console.log(`[dispatcher] Post-wake cognify: HTTP ${res.status} — non-fatal`);
    }
    await appendCogneeLog({ wake_label: label, day: dayNumber, chars_ingested: text.length, http_status: httpStatus });
  } catch (err) {
    console.log(`[dispatcher] Post-wake cognify skipped: ${err.message}`);
    await appendCogneeLog({ wake_label: label, day: dayNumber, chars_ingested: 0, http_status: null, error: err.message }).catch(() => {});
  }
}

/**
 * Append one entry to workspace/logs/cognee/YYYY-MM.json.
 * Creates the file and directory if they don't exist.
 * Each entry: { timestamp, wake_label, day, chars_ingested, http_status, error? }
 */
async function appendCogneeLog(entry) {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const monthKey = new Date().toLocaleDateString('en-CA', { timeZone: tz }).substring(0, 7); // YYYY-MM
  const logDir = path.join(WORKSPACE_PATH, 'logs', 'cognee');
  const logFile = path.join(logDir, `${monthKey}.json`);
  await fs.mkdir(logDir, { recursive: true });
  let entries = [];
  try {
    entries = JSON.parse(await fs.readFile(logFile, 'utf-8'));
  } catch {}
  entries.push({ timestamp: new Date().toISOString(), ...entry });
  await fs.writeFile(logFile, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─── Last-Cited Auto-Update ──────────────────────────────────────────────────

/**
 * After each wake, scan the wake's text output and plan summaries for case
 * names cited in posts or theory notes. When found, update last_cited in the
 * matching workspace/cases/*.json file to today's date.
 * Non-blocking — called with .catch() so failures never delay the return.
 */
const CASE_PATTERNS = [
  { patterns: [/\b(Hampton|breakfast program|BPP|Black Panther)\b/i], id: 'bpp-breakfast-program' },
  { patterns: [/\b(Zapatista|EZLN|GAL restructur|Chiapas)\b/i], id: 'zapatista-gal-restructuring-2023' },
  { patterns: [/\b(Minneapolis template|Minneapolis cooperative|May Day Cooperative|Shared Capital Cooperative)\b/i], id: 'minneapolis-template-2026' },
  { patterns: [/\bHillsboro\b/i], id: 'hillsboro-underground-mutual-aid' },
  { patterns: [/\bParis Commune\b/i], id: 'paris-commune-1871' },
];

async function updateLastCited(label, dayNumber, planFile, writeTargets, wakeText) {
  try {
    const CASES_PATH = path.join(PROJECT_ROOT, 'workspace', 'cases');
    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    // Collect searchable text: plan summaries + vault writes + wake response (first 8000 chars)
    const parts = [];
    if (wakeText) parts.push(wakeText.substring(0, 8000));
    if (planFile) {
      try {
        const plan = JSON.parse(await fs.readFile(planFile, 'utf-8'));
        const summaries = (plan.tasks || []).map(t => t.summary || '').join(' ');
        parts.push(summaries);
        if (plan.theory_praxis) parts.push(plan.theory_praxis);
      } catch {}
    }
    for (const fp of writeTargets.slice(0, 5)) {
      try {
        const content = await fs.readFile(fp, 'utf-8');
        parts.push(content.substring(0, 1000));
      } catch {}
    }
    const combinedText = parts.join('\n');
    if (!combinedText.trim()) return;

    const updated = [];
    for (const { patterns, id } of CASE_PATTERNS) {
      const matched = patterns.some(re => re.test(combinedText));
      if (!matched) continue;
      const caseFile = path.join(CASES_PATH, `${id}.json`);
      try {
        const caseData = JSON.parse(await fs.readFile(caseFile, 'utf-8'));
        if (caseData.last_cited === today) continue; // already current
        caseData.last_cited = today;
        await fs.writeFile(caseFile, JSON.stringify(caseData, null, 2));
        updated.push(id);
      } catch {}
    }
    if (updated.length > 0) {
      console.log(`[dispatcher] last_cited updated for ${updated.length} case(s): ${updated.join(', ')}`);
    }
  } catch (err) {
    console.log(`[dispatcher] updateLastCited skipped: ${err.message}`);
  }
}

// ─── Wake Interface ──────────────────────────────────────────────────────────

/**
 * Execute a wake using a single Claude Code invocation.
 * Replaces the entire planner/worker architecture.
 */
export async function executeWake(label, time, purpose = null) {
  const dayNumber = await getDayNumber();

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  });

  // Load pending improvements inline so wakes don't need a separate Read call
  let pendingImprovements = '';
  try {
    const improvementsPath = path.join(WORKSPACE_PATH, 'improvements.md');
    const content = await fs.readFile(improvementsPath, 'utf-8');
    // Collect all [pending] items regardless of which section they're in
    const lines = content.split('\n').filter(l => l.includes('[pending]'));
    if (lines.length > 0) {
      pendingImprovements = `## Pending Improvements\n${lines.join('\n')}`;
    }
  } catch {
    // improvements.md missing — not fatal
  }

  // Night wake gets a study session focus instead of search-and-post
  const isNightWake = label === 'night';
  // Reddit wake gets a dedicated engagement protocol instead of generic Bluesky loop
  const isRedditWake = label === 'reddit';
  // Essay wake: dedicated long-form publishing session — write → publish → announce
  const isEssayWake = label === 'essay';

  // On morning wakes, snapshot follower/following/posts counts for trend tracking
  if (label === 'morning') {
    await snapshotFollowers(); // non-fatal — errors logged, wake continues
  }

  // Check facet verification failure rate — warn if hashtags are breaking
  const facetWarning = await getFacetWarning();

  // Check for wake quality drift — warn before robot-kombucha recurs
  const driftAlert = await getWakeDriftAlert();

  // Check organizer baseline — evaluate A/B experiment gate
  const organizerBaselineContext = await getOrganizerBaseline();

  // Cognee auto-recall — query knowledge graph for relevant past context
  // Uses purpose if set (self-scheduled), otherwise falls back to label
  const cogneeQuery = purpose
    ? purpose.substring(0, 200)
    : `${label} wake organizing mutual aid cooperative dual power`;
  const cogneeContext = await getCogneeRecall(cogneeQuery);

  // Cross-platform post coordination — detect topic overlap before posting
  const crossPlatformContext = !isNightWake ? await getCrossPlatformSummary() : null;

  // Load theory-derived search queries from last night's study session
  let studyQueriesContext = '';
  let provenQueriesContext = '';
  if (!isNightWake) {
    try {
      const sqPath = path.join(WORKSPACE_PATH, 'memory', 'study_queries.md');
      const sqContent = await fs.readFile(sqPath, 'utf-8');
      // Split on section headers; sections[0] is the file header block (title, preamble).
      // Filter to only dated sections (## YYYY-...) so we get the most recent query set.
      const sections = sqContent.split(/\n(?=## \d{4}-)/).filter(s => s.trim());
      const dateSections = sections.filter(s => /^## \d{4}-/.test(s.trimStart()));
      if (dateSections.length > 0) {
        // Filter out queries already marked ✗ noise — dead leads waste context and cause repeated failed searches
        const sectionLines = dateSections[0].split('\n');
        const filteredLines = sectionLines.filter(l => !l.includes('✗ noise'));
        const noiseCount = sectionLines.length - filteredLines.length;
        const queryLines = filteredLines.filter(l => /^\d+\./.test(l.trim()));

        if (queryLines.length > 0) {
          const filteredSection = filteredLines.join('\n').trim();
          const noiseNote = noiseCount > 0 ? ` *(${noiseCount} noise-marked quer${noiseCount !== 1 ? 'ies' : 'y'} hidden — already logged as dead)*` : '';
          studyQueriesContext = `## Theory-Derived Search Queries (from last night's study)\n${filteredSection}\n\n*After searching with any of these queries, call \`log_query_outcome\` with the query text, outcome ("productive"/"noise"), and a one-line note. This closes the theory→query→material feedback loop.*${noiseNote}`;
        } else if (noiseCount > 0) {
          // All queries marked noise — surface this instead of showing an empty section
          studyQueriesContext = `## Theory-Derived Search Queries\n*All ${noiseCount} queries from the most recent study session are marked noise. Night wake study session needed to generate fresh queries.*`;
        }
      }
    } catch {
      // No study_queries.md — not fatal
    }
    provenQueriesContext = await getProvenQueries();
  }

  // Proactively replenish theory queue on night wakes (before prompt is built)
  if (isNightWake) await proactiveQueueReplenishment();

  // Auto-extract theory candidates from recent journals on night wakes
  const autoQueueContext = isNightWake ? await autoQueueFromJournal() : '';

  // Theory gap → essay pipeline suggestion (night wake only)
  const essayAutoSchedule = isNightWake ? await getEssayAutoScheduleSuggestion() : '';

  // Load next unposted theory item for distribution prompt
  const theoryQueueItem = isNightWake ? null : await getTheoryQueueItem();

  // Pre-generate essay draft for long-form theory items (non-blocking)
  let longFormDraftPath = null;
  if (theoryQueueItem?.longForm) {
    longFormDraftPath = await writeLongFormDraft(theoryQueueItem);
  }

  // Theory distribution gap — vault sections never queued + ready-to-distribute count
  const theoryGapSummary = !isNightWake ? await getTheoryGapSummary() : '';

  // Hashtag signal quality — which tags correlate with organizer engagement vs general likes
  const hashtagSignalContext = !isNightWake ? await getHashtagEffectivenessSummary() : '';

  // Theory queue low-water alert — inject warning if ≤2 [pending] items remain
  const theoryQueueAlert = await getTheoryQueueAlert();

  // Candidate queue alert — surface [candidate] items if ≥3 have accumulated without promotion
  const candidateQueueAlert = await getCandidateQueueAlert();

  // Overdue threads alert — flag past-due deadlines in Threads.md
  const overdueThreadsAlert = await getOverdueThreadsAlert();

  // Write.as token warning — surface missing token at wake time, not publish time
  const writeasTokenWarning = getWriteasTokenWarning();

  // Improve-wake count warning — flag if ≥4 improve sessions already today
  const improveWakeWarning = await getImproveWakeWarning();

  // Daily cost summary — compact per-type breakdown for non-night wakes
  const dailyCostSummary = !isNightWake ? await getDailyCostSummary() : '';

  // Engagement velocity alert — post gaining traction within 12h = join while live
  const tractionAlert = !isNightWake ? await getTractionAlert() : '';

  // Mastodon viral spread alert — ≥10 unique boosters for any post in last 24h
  const mastodonSpreadAlert = await getMastodonSpreadAlert();

  // Theory resonance score — decay-weighted per-post organizer engagement; surfaces what's currently resonating
  const resonanceScoreContext = !isNightWake ? await getTheoryResonanceScore() : '';

  // Content-type × hashtag crosstab — best (content_type, hashtag) pair by signal quality
  const crossTabContext = !isNightWake ? await getCrossTabRecommendation() : '';

  // Time-of-day scheduling signal — wires analysis output to actual scheduling decisions
  const timeOfDayContext = !isNightWake ? await getTimeOfDayRecommendation() : '';

  // Context size trend baseline — 7-day rolling average for inflation detection
  const contextSizeBaseline = await getContextSizeBaseline();

  // Wake gap — how long since the last wake completed (2h vs 8h changes what needs checking)
  const hoursSinceLastWake = await getHoursSinceLastWake();

  // Wake quality 7-day trend — shows whether quality is improving/stable/declining across regular wakes
  const wakeQualityTrend = await getWakeQualityTrend();

  // Comrade follow-up context — last heard from each active comrade, prevents silence and repeat-messaging
  const comradeReplyContext = await getComradeReplyContext();

  // Mook outline detection — alert if DM from mook contains ≥2 Markdown headers (outline arrived)
  const mookOutlineAlert = await getMookOutlineAlert();

  // On non-night wakes, pre-fetch RSS headlines to surface material before first search
  const rssContext = !isNightWake ? await fetchRSSFeeds() : '';

  // Get prior plans for today — cap to last 3 wakes to prevent context bloat on busy days
  const PRIOR_PLANS_DISPLAY = 3;
  let priorPlansSummary = '';
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const todayFiles = files.filter(f => f.startsWith(today) && f.endsWith('.json')).sort();
    const earlier = todayFiles.length > PRIOR_PLANS_DISPLAY ? todayFiles.length - PRIOR_PLANS_DISPLAY : 0;
    const toShow = todayFiles.slice(-PRIOR_PLANS_DISPLAY);
    if (earlier > 0) {
      priorPlansSummary += `*(${earlier} earlier wake${earlier > 1 ? 's' : ''} not shown — read workspace/plans/ for full history)*\n`;
    }
    for (const file of toShow) {
      const plan = JSON.parse(await fs.readFile(path.join(PLANS_PATH, file), 'utf-8'));
      priorPlansSummary += `\n### ${plan.wake} (${plan.time}) — ${plan.status}\n`;
      for (const task of plan.tasks) {
        const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : '·';
        priorPlansSummary += `${icon} ${task.type}: ${task.summary || task.reason}\n`;
      }
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to load prior wake plans: ${err.message}`);
  }

  // Determine plan filename — avoid clobbering when same label runs twice in a day
  let planFileSuffix = label;
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    let seq = 2;
    let candidate = `${today}_${label}.json`;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.access(path.join(PLANS_PATH, candidate));
        // File exists — try next sequence number
        candidate = `${today}_${label}${seq}.json`;
        seq++;
      } catch {
        // File doesn't exist — this name is free
        break;
      }
    }
    planFileSuffix = candidate.replace('.json', '').replace(`${today}_`, '');
  } catch {
    // Non-fatal — fall back to label
  }

  const studySessionInstructions = isNightWake ? [
    ``,
    `## Study Session (Night Wake — Required)`,
    `This wake is your daily study session. Less search-and-post, more theory-and-synthesis.`,
    ``,
    `1. Open obsidian/ComradeClaw/Theory/Core Positions.md. Pick ONE position or thinker you haven't engaged recently.`,
    `2. WebSearch for something recent that connects to it: a news item, an organizing development, a debate. Look for the friction between theory and current events.`,
    `3. Write one paragraph in obsidian/ComradeClaw/Theory/Core Positions.md (or a journal entry) documenting what shifted or clarified. Not summary — the thing that changes what you'd do tomorrow.`,
    `4. Generate 2-3 search queries for tomorrow's morning wake that come from this reading. Write them to workspace/memory/study_queries.md (create if needed). Label them with tomorrow's date. Prepend new entries — newest section at top.`,
    `5. If tonight's theory connected to something happening on Bluesky, post it. If not, silence is fine — don't manufacture a connection.`,
    `6. **Theory queue replenishment (required when queue is low):** Read workspace/theory_queue.md. Count [unposted] items. If fewer than 3 remain, generate 3 new theory distribution items from tonight's reading and append them to workspace/theory_queue.md. Source from positions in Core Positions.md that haven't been queued yet. Format: \`- **[unposted]** **Title** — Description\`. The pipeline must not run dry.`,
    `7. **Essay scheduling:** After replenishment, if the queue has ≥1 [unposted] item, self-schedule an essay wake for tomorrow at 2pm local (18:00 UTC). Add to workspace/scheduled_wakes.json: {"id":"<timestamp>-essay","label":"essay","purpose":"Essay pipeline: write and publish the next unposted theory queue item as an 800-1200 word Write.as essay. See Essay Wake Protocol.","fire_at":"<tomorrow 18:00 UTC>","scheduled_by":"self","status":"pending"}. One essay wake per day maximum — don't queue duplicates.`,
    ``,
    `## Theory Drift Check (Night Wake — Required)`,
    `After any update to obsidian/ComradeClaw/Theory/Core Positions.md, write an explicit drift record in the same journal entry:`,
    `- **OLD:** [what you held before tonight]`,
    `- **NEW:** [what shifted or clarified]`,
    `- **VERDICT:** supersede (old position replaced) / hold tension (both valid in different contexts) / reject (new reading didn't hold up)`,
    `Theory must not evolve in silence. If nothing shifted tonight, write "No drift — position held." That is also a data point.`,
  ].join('\n') : '';

  const redditEngagementInstructions = isRedditWake ? [
    ``,
    `## Reddit Engagement Protocol (Reddit Wake — Required)`,
    `This wake is dedicated to organizing work on Reddit. Reddit discussions run deeper than Bluesky — longer arguments, more context, real debate. Use it.`,
    ``,
    `**Subreddits to check (in this order):**`,
    `1. r/cooperatives — worker cooperative launches, member conflict stories, governance debates`,
    `2. r/MutualAid — active aid requests, network-building threads, resource coordination`,
    `3. r/LaborOrganizing — campaign updates, union drives, workplace disputes`,
    `4. r/antiwork — solidarity opportunities, but filter for actionable threads over venting`,
    ``,
    `**Engagement protocol:**`,
    `a. Run \`reddit_monitor_watchlist\` first — check what's new since last check.`,
    `b. Run \`reddit_fetch_subreddit\` on r/cooperatives, r/MutualAid, r/LaborOrganizing (hot posts).`,
    `c. For each subreddit: skim top 5 posts. Find ONE thread where you have something concrete to add — theory, historical parallel, practical question, resource pointer.`,
    `d. Use \`reddit_fetch_post\` to read the full thread before commenting. Don't comment on headlines.`,
    `e. Post ONE theory-grounded comment. This is not a reply to every thread — pick the best one and say something real. The comment should:`,
    `   - Add something the thread doesn't already have (not just "great point" or restating OP)`,
    `   - Be grounded in actual theory or history (Hampton, Mondragon, Paris Commune, dual power — whatever fits)`,
    `   - Ask a genuine question if appropriate — Reddit rewards engaged discussion, not lectures`,
    `   - Be 2-4 sentences. Not an essay. Not a one-liner.`,
    `f. After posting, log the thread URL + subreddit in today's plan file under tasks.`,
    ``,
    `**Mission check:** Does this comment advance cooperative infrastructure, mutual aid, labor organizing, or dual power theory? If you can't answer yes, don't post it. Silence is better than noise.`,
    ``,
    `**Also run standard Bluesky + Mastodon engagement this wake** — reddit doesn't replace it, adds to it.`,
  ].join('\n') : '';

  // Organizer streak check — inject cooling contacts so wake can re-engage them
  // Also surfaces cold contacts (7-14d) that are slipping away and need intentional recovery
  // Also detects cooling→active transitions (re-engagement) and suggests a public shoutout
  let coolingContactsContext = '';
  try {
    const {
      getCoolingContacts,
      getColdContacts,
      getCoolingToActiveContacts,
      saveCoolingSnapshot,
    } = await import('./organizer_contacts.js');

    // Load previous snapshot FIRST, then get current contacts, THEN save new snapshot
    const [cooling, cold, reengaged] = await Promise.all([
      getCoolingContacts(),
      getColdContacts(),
      getCoolingToActiveContacts(),
    ]);

    // Save current cooling state as baseline for next wake's comparison
    saveCoolingSnapshot().catch(e =>
      console.error(`[dispatcher] saveCoolingSnapshot failed: ${e.message}`)
    );

    const parts = [];

    if (reengaged.length > 0) {
      const names = reengaged.map(c => c.handle).join(', ');
      parts.push(
        `## Re-engaged Comrades — Call Them Out\n` +
        `These contacts were cooling (3-7d silent) but just came back: ${names}\n` +
        `Use the \`shoutout\` tool or mention them in your next post. Reward re-engagement publicly — this is solidarity practice, not metrics.`
      );
    }

    if (cooling.length > 0) {
      const names = cooling.map(c => `${c.handle} (${c.daysSince}d since last engagement)`).join(', ');
      parts.push(`## Relationships to Maintain\nThese contacts engaged recently but haven't engaged in 3-7 days — worth keeping warm: ${names}`);
    }
    if (cold.length > 0) {
      const coldLines = cold.map(c => {
        const action = buildRecoveryPrompt(c);
        return `  - ${c.handle} (${c.daysSince}d): ${action}`;
      }).join('\n');
      parts.push(`⚠️ Going cold (7-14d, still recoverable) — one action each can re-open these:\n${coldLines}`);
    }
    if (parts.length > 0) coolingContactsContext = '\n' + parts.join('\n');
  } catch (err) {
    console.error(`[dispatcher] organizer_contacts failed: ${err.message}`);
  }

  const essayWakeInstructions = isEssayWake ? [
    ``,
    `## Essay Wake Protocol (Required — this is the entire purpose of this wake)`,
    `You are here to produce one published Write.as essay. Not a thread. Not a plan to write one later. A complete, published essay.`,
    ``,
    `**Step 1 — Read the queue.**`,
    `Open workspace/theory_queue.md. Find the first \`[unposted]\` item. That is your subject.`,
    ``,
    `**Step 2 — Write the essay (800–1200 words).**`,
    `Structure:`,
    `- **Opening**: a concrete scene, event, or claim that earns the reader's attention in 1-2 sentences. Not an abstract thesis — start with something that happened.`,
    `- **The argument**: what you are actually claiming and why it matters. One central claim, fully developed.`,
    `- **Evidence and history**: at least 2 historical/material examples. Hampton, Mondragon, Paris Commune, Zapatistas, Minneapolis 2026, the specific cooperative or mutual aid network you know about. Real, named examples.`,
    `- **The complication**: where the argument gets hard. What has failed, what the limits are, what the state has done to absorb or destroy. Do not skip this section. Essays that skip complication are propaganda, not argument.`,
    `- **Implication**: what does this mean for someone reading right now? Concrete, actionable, not abstract.`,
    ``,
    `**Step 3 — Publish.**`,
    `Call \`writeas_publish\` with:`,
    `- title: the item title from the queue`,
    `- body: the full markdown essay`,
    `- collection: use WRITEAS_COLLECTION env var (the server falls back to it automatically — just omit the parameter)`,
    `- font: norm`,
    `Save the returned URL.`,
    ``,
    `**Step 4 — Mark posted.**`,
    `In workspace/theory_queue.md, change \`[unposted]\` to \`[posted ${today}]\` for this item.`,
    ``,
    `**Step 5 — Announce on both platforms.**`,
    `Bluesky: 2-3 post thread. Post 1: the core claim (≤280 chars, hooks the reader). Post 2: one key piece of evidence or the sharpest implication. Post 3: "Full argument at [URL]" + the Write.as link.`,
    `Mastodon: single post ≤480 chars. Core claim + Write.as link. Fediverse will federate the essay automatically at Pro tier.`,
    ``,
    `**Step 6 — Standard respond sweep.**`,
    `After publishing: run read_replies + mastodon_read_notifications. Reply to anything real.`,
    ``,
    `**What this wake is NOT:**`,
    `- Not a theory thread (threads have 5 posts; essays have 800 words; they are different arguments)`,
    `- Not a draft to be finished later (if you publish a draft you're not done; you're behind)`,
    `- Not skippable if the queue item "doesn't feel ready" — the queue item is already the argument; your job is to expand it, not approve it`,
  ].join('\n') : '';

  // For essay wakes, append the *live* first unposted item so the purpose field
  // (set at schedule time) never shows a stale topic that was already posted.
  const essayLiveItem = isEssayWake && theoryQueueItem && theoryQueueItem.title
    ? `Current first unposted item: '${theoryQueueItem.title}' — ${theoryQueueItem.description.substring(0, 120)}...`
    : null;
  const selfWakeContext = purpose
    ? [`## Self-Scheduled Wake`, `This wake was self-scheduled for a specific purpose:`, `**${purpose}**`, essayLiveItem || '', `Complete this before the standard wake protocol. This is why you woke up.`, ``].filter(l => l !== null).join('\n')
    : '';

  const dynamicContext = [
    `You are Comrade Claw. This is your ${label} wake. It is ${timeStr} on ${dateStr}. Day ${dayNumber}.${hoursSinceLastWake !== null ? ` (${hoursSinceLastWake}h since last wake)` : ''}`,
    selfWakeContext ? `\n${selfWakeContext}` : '',
    coolingContactsContext ? coolingContactsContext : '',
    cogneeContext ? `\n${cogneeContext}` : '',
    '',
    `## Instructions`,
    `1. Read workspace/SOUL.md to ground yourself.`,
    `2. Read your memory files (obsidian/ComradeClaw/Characters.md, obsidian/ComradeClaw/Threads.md, obsidian/ComradeClaw/Theory/Core Positions.md).`,
    `3. Your pending improvements are listed below. Pick one and implement it. If the list is empty, read src/dispatcher.js or src/mcp/bluesky-server.js, find something real to improve, add it to workspace/improvements.md, then implement it. An empty backlog is not permission to skip.`,
    `4. Check today's prior wake plans in workspace/plans/ for continuity.`,
    isNightWake
      ? `5. **Tonight is study session night — see Study Session instructions below. Bluesky engagement is secondary to the theory work.**`
      : isRedditWake
        ? `5. **Reddit engagement protocol — see Reddit Engagement instructions below. This is the primary work for this wake.**`
        : isEssayWake
          ? `5. **Essay wake — see Essay Wake Protocol below. Publishing comes first. Engagement is secondary.**`
          : `5. **Engage on Bluesky AND Mastodon — both required every wake:**`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   **Bluesky:**`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   a. Run read_replies. If anyone replied, respond to what's real.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   b. Run search_posts on 2-3 queries (e.g. "worker cooperative", "mutual aid organizing", "community fridge"). Find live conversations.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   c. Like at least 2 posts from real organizers. Repost at least 1. Reply to at least 1 where you have something concrete to add.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   d. **Thread-first policy:** When the argument needs >2 sentences, use bluesky_thread. Single posts for single observations. Threads for arguments. bluesky_thread is shipped — use it.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   **Mastodon (same commitment — fediverse has higher organizer density):**`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   e. Run mastodon_read_notifications. Respond to any replies or mentions.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   f. Run mastodon_search on 2-3 queries (same or related topics as Bluesky). Find organizers not on Bluesky.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   g. Favourite at least 1 post. Boost at least 1. Reply where you have something real to add.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   h. Two networks, same solidarity. Finding a conversation and doing nothing is not engagement.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   **Reddit (third network — higher theory density):**`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   i. Run reddit_monitor_watchlist — check r/cooperatives, r/MutualAid, r/LaborOrganizing for new posts since last check.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   j. If new posts found: pick ONE thread, read it fully with reddit_fetch_post, then engage if you have something concrete — theory, historical parallel, resource pointer.`,
    (isNightWake || isRedditWake || isEssayWake) ? `` : `   k. Silence beats a generic comment. Hampton/dual-power analysis has a home on Reddit that Mastodon doesn't reach.`,
    `6. Decide what else this wake is for. **Improvement is expected every wake.** If you skip it, record why in the plan file — the skip requires justification, not the improvement. Choose from: check_inbox, search, journal, distribute, memory, respond, improve, send_email${isNightWake ? ', study' : isRedditWake ? ', reddit' : isEssayWake ? ', essay' : ''}.`,
    `7. Execute the work using your tools. For code changes, always run: git add -A && git commit -m "Improve: <what and why>"`,
    `8. When done, write a plan file to workspace/plans/${today}_${planFileSuffix}.json with this format:`,
    `   {"wake":"${label}","time":"${time}","day":${dayNumber},"date":"${today}","status":"complete","bold_check":"yes/no — <one sentence: was this wake bold or did it play it safe?>","theory_praxis":"<what theory touched the work today, or 'none'>","tasks":[{"id":1,"type":"<type>","status":"done","reason":"<why>","summary":"<what happened>"}]}`,
    studySessionInstructions,
    redditEngagementInstructions,
    essayWakeInstructions,
    '',
    pendingImprovements || '## Pending Improvements\n*(none — read src/dispatcher.js or src/mcp/bluesky-server.js and find something)*',
    studyQueriesContext ? `\n${studyQueriesContext}` : '',
    provenQueriesContext ? `\n${provenQueriesContext}` : '',
    theoryQueueItem && theoryQueueItem.empty
      ? `\n## ⚠️ THEORY QUEUE EMPTY\nAll items in workspace/theory_queue.md have been posted. The theory→distribution pipeline will produce nothing until new items are added. Before this wake ends: open workspace/theory_queue.md, read obsidian/ComradeClaw/Theory/Core Positions.md, and add at least 3 new [unposted] items from positions that haven't been queued yet. Format: - **[unposted]** **Title** — Description`
      : theoryQueueItem && theoryQueueItem.title
        ? `\n## Theory Item Queued for Today\n**${theoryQueueItem.title}**: ${theoryQueueItem.description}${theoryQueueItem.longForm ? `\n\n📝 **Long-form item (${theoryQueueItem.description.length} chars > 1500 threshold):** This argument is too dense for a direct thread. ${longFormDraftPath ? `A pre-structured draft has been written to \`${longFormDraftPath}\`. Read it, expand each section, and publish via \`writeas_publish\`. Then post a 2-3 part bluesky_thread with the core claim + Write.as link.` : 'Publish as a Write.as essay via `writeas_publish` (full argument, ~800-1000 words), then post a 2-3 part bluesky_thread with core claim + link.'} The thread is the hook; the essay is the argument. Do not compress this into 10 posts — compression loses the reasoning.` : `\nIf you post this as a thread today, mark it \`[posted ${today}]\` in workspace/theory_queue.md. If it doesn't fit this wake, leave it — it will appear next wake.`}${theoryQueueItem.remaining <= 2 ? `\n\n⚠️ Only ${theoryQueueItem.remaining} item(s) left in theory queue. Add new items from Core Positions.md soon.` : ''}`
        : '',
    theoryGapSummary ? `\n${theoryGapSummary}` : '',
    rssContext ? `\n${rssContext}\n*(Headlines pre-fetched from subscribed feeds. Indented lines show live Bluesky conversations already discussing that article — join existing threads before starting new ones.)*` : '',
    '',
    priorPlansSummary ? `## Today's Earlier Wakes\n${priorPlansSummary}` : '*No previous wakes today — this is your first.*',
    '',
    `## Tools Available`,
    `- Read/Write/Edit: journals (workspace/logs/journal/), memory, plans, SOUL, your own code`,
    `- WebSearch: find cooperative news, mutual aid, theory, local things that matter`,
    `- Bluesky MCP: bluesky_post, bluesky_reply, bluesky_thread, read_timeline, read_replies, search_posts, like_post, repost, search_accounts`,
    `- Mastodon MCP: mastodon_post, mastodon_reply, mastodon_read_notifications, mastodon_search, mastodon_favourite, mastodon_boost, mastodon_follow`,
    `- Reddit MCP: reddit_fetch_subreddit, reddit_fetch_post, reddit_search, reddit_monitor_watchlist`,
    `- Write.as MCP: writeas_publish, writeas_update, writeas_list, writeas_delete`,
    `- Cognee MCP: search (semantic search across all past activity, characters, theory — query your knowledge graph)`,
    `- Bash: any utility scripts, git commits for self-improvements`,
    '',
    `**Mission check before any Bluesky post:** Does this post advance FALGSC — cooperative infrastructure, mutual aid, labor organizing, dual power, or the theory behind them? If the answer is no or uncertain, don't post it. Silence is better than drift. The robot kombucha posts (Days 18-20) were drift. Don't repeat that.`,
    facetWarning ? `\n${facetWarning}` : '',
    driftAlert ? `\n${driftAlert}` : '',
    organizerBaselineContext ? `\n${organizerBaselineContext}` : '',
    hashtagSignalContext ? `\n${hashtagSignalContext}` : '',
    crossTabContext ? `\n${crossTabContext}` : '',
    theoryQueueAlert ? `\n${theoryQueueAlert}` : '',
    candidateQueueAlert ? `\n${candidateQueueAlert}` : '',
    overdueThreadsAlert ? `\n${overdueThreadsAlert}` : '',
    writeasTokenWarning ? `\n${writeasTokenWarning}` : '',
    improveWakeWarning ? `\n${improveWakeWarning}` : '',
    dailyCostSummary ? `\n${dailyCostSummary}` : '',
    essayAutoSchedule ? `\n${essayAutoSchedule}` : '',
    autoQueueContext ? `\n${autoQueueContext}` : '',
    tractionAlert ? `\n${tractionAlert}` : '',
    mastodonSpreadAlert ? `\n${mastodonSpreadAlert}` : '',
    resonanceScoreContext ? `\n${resonanceScoreContext}` : '',
    timeOfDayContext ? `\n${timeOfDayContext}` : '',
    crossPlatformContext ? `\n${crossPlatformContext}` : '',
    comradeReplyContext ? `\n${comradeReplyContext}` : '',
    mookOutlineAlert ? `\n${mookOutlineAlert}` : '',
    wakeQualityTrend ? `\n${wakeQualityTrend}` : '',
    ``,
    `Empty wakes are valid. Not every wake needs output. The rhythm matters.`
  ].join('\n');

  const prompt = `This is your ${label} wake. Day ${dayNumber}. Begin.`;

  // Log context size — growing context = growing cost; makes inflation visible
  const contextChars = dynamicContext.length;
  const contextKb = Math.round(contextChars / 102.4) / 10;
  console.log(`[dispatcher] Wake: ${label} (Day ${dayNumber}) — context: ${contextChars} chars (${contextKb}KB)`);

  // Per-block char counts — used for both token estimates and context size breakdown alert
  const blockChars = {
    prior_plans: priorPlansSummary?.length || 0,
    rss_feeds: rssContext?.length || 0,
    theory_gap: theoryGapSummary?.length || 0,
    hashtag_signal: hashtagSignalContext?.length || 0,
    comrade_reply: comradeReplyContext?.length || 0,
    study_queries: studyQueriesContext?.length || 0,
    proven_queries: provenQueriesContext?.length || 0,
    wake_quality_trend: wakeQualityTrend?.length || 0,
    pending_improvements: pendingImprovements?.length || 0,
    drift_alert: driftAlert?.length || 0,
    auto_queue: autoQueueContext?.length || 0,
    overdue_threads: overdueThreadsAlert?.length || 0,
    mastodon_spread: mastodonSpreadAlert?.length || 0,
    resonance_score: resonanceScoreContext?.length || 0,
    cross_tab: crossTabContext?.length || 0,
    candidate_queue: candidateQueueAlert?.length || 0,
  };

  // Context size trend alert — inject warning if current wake is >20% above 7-day rolling average
  if (contextSizeBaseline && contextKb > contextSizeBaseline.avg * 1.2) {
    const avgFmt = contextSizeBaseline.avg.toFixed(1);
    // Top 3 largest blocks by char count — replaces vague "check what's growing"
    const top3 = Object.entries(blockChars)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, chars]) => `${name} (${(Math.round(chars / 102.4) / 10).toFixed(1)}KB)`)
      .join(', ');
    dynamicContext += `\n⚠️ Context size elevated: ${contextKb}KB vs ${avgFmt}KB avg (${contextSizeBaseline.count} wakes, 7d) — largest blocks: ${top3}`;
    console.warn(`[dispatcher] Context size elevated: ${contextKb}KB vs ${avgFmt}KB avg — top blocks: ${top3}`);
  }

  // Per-block token estimates — chars/4 approximation; injected into plan file post-run
  const est = (s) => Math.round((s?.length || 0) / 4);
  const contextBlockTokens = {
    total_estimated: Math.round(contextChars / 4),
    prior_plans: est(priorPlansSummary),
    rss_feeds: est(rssContext),
    theory_gap: est(theoryGapSummary),
    hashtag_signal: est(hashtagSignalContext),
    comrade_reply: est(comradeReplyContext),
    study_queries: est(studyQueriesContext),
    proven_queries: est(provenQueriesContext),
    wake_quality_trend: est(wakeQualityTrend),
    pending_improvements: est(pendingImprovements),
    drift_alert: est(driftAlert),
    auto_queue: est(autoQueueContext),
    overdue_threads: est(overdueThreadsAlert),
    mastodon_spread: est(mastodonSpreadAlert),
    resonance_score: est(resonanceScoreContext),
    cross_tab: est(crossTabContext),
    candidate_queue: est(candidateQueueAlert),
  };

  // Timeout scaling by label. Intensive labels get 20 min; self-scheduled (purpose set) gets 25 min; all others 10 min.
  const INTENSIVE_LABELS = new Set(['improve', 'research', 'upgrade', 'connector', 'deep', 'reddit', 'solidarity', 'sunday-metrics', 'morning', 'noon', 'afternoon', 'evening', 'night']);
  const wakeTimeout = purpose ? 25 * 60 * 1000 : INTENSIVE_LABELS.has(label) ? 20 * 60 * 1000 : 10 * 60 * 1000;

  const result = await invokeClaude(prompt, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: wakeTimeout
  });

  // Token estimates: input from context chars, output from result text length
  const inputTokenEst = contextBlockTokens.total_estimated;
  const outputTokenEst = Math.round(result.text.length / 4);
  const totalTokenEst = inputTokenEst + outputTokenEst;
  const runawayContext = totalTokenEst > 50000;
  if (runawayContext) {
    console.warn(`[dispatcher] RUNAWAY CONTEXT: ${label} wake estimated ${totalTokenEst} tokens (input: ${inputTokenEst}, output: ${outputTokenEst}) — exceeds 50K threshold`);
  }

  const dailyCost = await accumulateDailyCost(result.cost, label, result.toolsUsed, {
    context_chars: contextChars,
    context_kb: contextKb,
    input_tokens_est: inputTokenEst,
    output_tokens_est: outputTokenEst,
    total_tokens_est: totalTokenEst,
  });
  console.log(`[dispatcher] Wake complete: ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);
  const costThreshold = await getAdaptiveCostThreshold();
  if (dailyCost >= costThreshold) {
    console.warn(`[dispatcher] COST ALERT: daily total $${dailyCost.toFixed(4)} >= adaptive threshold $${costThreshold.toFixed(2)} (7-day avg × 1.5)`);
  }

  // Check for operator absence — schedule welfare-check wake if needed
  await checkOperatorAbsence();

  // Check for overdue contacts — schedule follow-up wakes if needed
  await checkContactFollowUps();

  // Parse wake results
  const toolsUsed = result.toolsUsed || [];
  const writeTargets = result.writeTargets || [];

  // Find the plan file written during this wake
  let planFile = null;
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const candidates = files.filter(f => f.startsWith(`${today}_${label}`) && f.endsWith('.json'));
    if (candidates.length > 0) {
      // Sort by mtime (newest first) — string sort fails on improve9 vs improve21
      const withMtime = await Promise.all(candidates.map(async f => {
        const stat = await fs.stat(path.join(PLANS_PATH, f));
        return { f, mtime: stat.mtimeMs };
      }));
      withMtime.sort((a, b) => b.mtime - a.mtime);
      planFile = path.join(PLANS_PATH, withMtime[0].f);
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to locate plan file: ${err.message}`);
  }

  if (!planFile) {
    console.warn(`[dispatcher] Warning: no plan file found for ${label} wake — Claude may have skipped writing it`);
  }

  // Post-commit health check: if this wake modified source files, verify syntax
  // Includes src/mcp/*.js — these are modified most often in improve wakes
  const modifiedSrcFiles = writeTargets.filter(p =>
    /src[/\\].*\.js$/.test(p)
  );
  if (modifiedSrcFiles.length > 0) {
    await runHealthCheck(modifiedSrcFiles);
  }

  // journal_written: only true if a Write targeted the Obsidian journal directory
  const journalWritten = writeTargets.some(p => p.includes('obsidian/ComradeClaw/Journal/') || p.includes('obsidian\\ComradeClaw\\Journal\\'));

  // Inject quality score into plan file so degradation is visible at plan-time
  if (planFile) {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'workspace', 'scripts', 'wake_quality.js');
      const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--date', today, '--weekly-summary'], {
        cwd: PROJECT_ROOT,
        timeout: 15000,
      });
      const qualityData = JSON.parse(stdout.trim());
      const dayScore = qualityData.daily_scores?.[0];
      if (dayScore) {
        const planContent = JSON.parse(await fs.readFile(planFile, 'utf-8'));
        planContent.quality_score = `${dayScore.score}/12 (${dayScore.pct}%)`;
        planContent.context_tokens = contextBlockTokens;
        planContent.token_estimate = {
          input_est: inputTokenEst,
          output_est: outputTokenEst,
          total_est: totalTokenEst,
          runaway: runawayContext,
        };
        await fs.writeFile(planFile, JSON.stringify(planContent, null, 2));
        console.log(`[dispatcher] Quality score injected: ${planContent.quality_score} | tokens ~${totalTokenEst} (in:${inputTokenEst} out:${outputTokenEst})${runawayContext ? ' ⚠️ RUNAWAY' : ''}`);
      }
    } catch (err) {
      console.warn(`[dispatcher] Quality score injection failed (non-fatal): ${err.message}`);
    }
  }

  // Post-wake Cognee ingestion — feed wake outputs into knowledge graph (non-blocking)
  postWakeCognify(label, dayNumber, planFile, writeTargets).catch(() => {});

  // Auto-update last_cited in case registry when case names appear in posts/theory (non-blocking)
  updateLastCited(label, dayNumber, planFile, writeTargets, result.text).catch(() => {});

  // Prune stale study_queries.md sections on night wakes (non-blocking)
  if (label === 'night') {
    pruneOldStudyQuerySections().catch(() => {});
  }

  return {
    time,
    label,
    tools_used: toolsUsed,
    journal_written: journalWritten,
    bluesky_posted: toolsUsed.some(t => t.includes('bluesky_post')),
    memory_updated: toolsUsed.some(t => t === 'Edit' || t === 'Write'),
    planFile,
    summary: result.text.length > 200 ? result.text.substring(0, 197) + '...' : result.text,
    empty: toolsUsed.length === 0,
    cost: result.cost
  };
}

// ─── Dream Wake ─────────────────────────────────────────────────────────────

const AUTO_MEMORY_DIR = 'C:/Users/kenne/.claude/projects/E--ai-cclaw/memory';

/**
 * Truncate content from the front, keeping the most recent material.
 */
function truncateContent(content, maxChars, label) {
  if (content.length <= maxChars) return content;
  console.log(`[dispatcher] Dream: truncating ${label} from ${content.length} to ${maxChars} chars`);
  return '...(truncated from start)...\n' + content.slice(-maxChars);
}

/**
 * Execute the dream wake — nightly memory consolidation.
 * Gathers the day's material in Node.js and gives Claude a focused prompt
 * to extract what matters into the auto memory system.
 */
export async function executeDreamWake() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const dayNumber = await getDayNumber();

  // At 1:30am, "today" is the new day. Dream replays yesterday.
  const yesterday = new Date(Date.now() - 86400000);
  const targetDate = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

  console.log(`[dispatcher] Dream wake: replaying ${targetDate} (Day ${dayNumber - 1})`);

  // ── Discover what files exist for the target date ──
  // Instead of injecting content (which causes ENAMETOOLONG on Windows),
  // we tell Claude what files to read and let it use Read tool calls.

  let fileList = [];

  // Chat log
  const chatLogPath = path.join(WORKSPACE_PATH, 'logs', 'chat', `${targetDate}.md`);
  try { await fs.access(chatLogPath); fileList.push(`- Chat log: ${chatLogPath}`); } catch {}

  // Journal entries (Obsidian vault only — workspace/logs/journal/ is retired)
  try {
    const obsidianJournalDir = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Journal');
    const files = (await fs.readdir(obsidianJournalDir)).filter(f => f.startsWith(targetDate)).sort();
    for (const f of files) fileList.push(`- Journal: ${path.join(obsidianJournalDir, f)}`);
  } catch {}

  // Wake plans
  try {
    const files = (await fs.readdir(PLANS_PATH)).filter(f => f.startsWith(targetDate) && f.endsWith('.json')).sort();
    for (const f of files) fileList.push(`- Wake plan: ${path.join(PLANS_PATH, f)}`);
  } catch {}

  // Wake log
  const wakeLogPath = path.join(WORKSPACE_PATH, 'logs', 'wakes', `${targetDate}.json`);
  try { await fs.access(wakeLogPath); fileList.push(`- Wake log: ${wakeLogPath}`); } catch {}

  // Obsidian memory files (always include for context)
  try {
    const obsidianDir = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw');
    for (const f of ['Characters.md', 'Threads.md']) {
      try { await fs.access(path.join(obsidianDir, f)); fileList.push(`- Memory: ${path.join(obsidianDir, f)}`); } catch {}
    }
  } catch {}

  console.log(`[dispatcher] Dream: found ${fileList.length} files from ${targetDate}`);

  if (fileList.length === 0) {
    console.log(`[dispatcher] Dream: no material for ${targetDate}, skipping`);
    return {
      time: '01:30',
      label: 'dream',
      tools_used: [],
      journal_written: false,
      bluesky_posted: false,
      memory_updated: false,
      summary: `Dream: no activity found for ${targetDate}`,
      empty: true,
      cost: 0
    };
  }

  // ── Build a compact dream prompt (no inline content — avoids ENAMETOOLONG) ──

  const dynamicContext = [
    `You are Comrade Claw in dream mode. No Bluesky posting, no improvements, no engagement.`,
    `Replaying Day ${dayNumber - 1} (${targetDate}) to extract what matters into long-term memory.`,
    ``,
    `## Step 1: Read the day's material`,
    `Use the Read tool to read these files:`,
    fileList.join('\n'),
    ``,
    `## Step 2: Extract what matters`,
    `- Operator directives, key decisions, characters who became real`,
    `- Thread updates, theory shifts, engagement patterns, resources/references`,
    ``,
    `## Step 3: Write auto memory files`,
    `For each memory worth saving, Write a file to ${AUTO_MEMORY_DIR}/`,
    `Filename: dream_${targetDate}_<short-slug>.md`,
    `Frontmatter: name, description, type (project|feedback|reference)`,
    `Then update ${AUTO_MEMORY_DIR}/MEMORY.md with index entries.`,
    ``,
    `## Step 4: Knowledge Graph`,
    `If the cognify tool is available, feed key material into it as one text block.`,
    `If not available, skip silently.`,
    ``,
    `## Rules`,
    `- Read existing auto memory files first to avoid duplicates`,
    `- Do NOT modify workspace/memory/ or obsidian/ files`,
    `- Quality over quantity: 1-5 memory files typical. Zero is valid.`,
    `- Only persist what future Claw needs that isn't in code or git log.`,
  ].join('\n');

  const prompt = `Dream wake. Replay Day ${dayNumber - 1} (${targetDate}). Read the files listed in your instructions, extract what matters, write to auto memory.`;

  const result = await invokeClaude(prompt, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 15 * 60 * 1000,
  });

  const dailyCost = await accumulateDailyCost(result.cost, 'dream', result.toolsUsed);
  console.log(`[dispatcher] Dream complete: ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);

  const writeTargets = result.writeTargets || [];
  const memoryFilesWritten = writeTargets.filter(p => p.includes('.claude'));

  return {
    time: '01:30',
    label: 'dream',
    tools_used: result.toolsUsed || [],
    journal_written: false,
    bluesky_posted: false,
    memory_updated: memoryFilesWritten.length > 0,
    summary: memoryFilesWritten.length > 0
      ? `Dream: extracted ${memoryFilesWritten.length} memories from ${targetDate}`
      : `Dream: no new memories from ${targetDate}`,
    empty: memoryFilesWritten.length === 0,
    cost: result.cost,
    dream_memories: memoryFilesWritten.length,
    dream_target_date: targetDate,
  };
}

export default { invokeClaude, chat, executeWake, executeDreamWake, clearChatSession };
