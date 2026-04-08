#!/usr/bin/env node
/**
 * Weekly Metrics Pull — Comrade Claw
 *
 * Reads all plan files for the current week. Tallies:
 * - Wake count and quality (bold_check, theory_praxis)
 * - Incoming organizer engagements (distinct handles, types)
 * - Posts and top hashtags
 * - resources.md update frequency (git log)
 *
 * Run manually: node workspace/scripts/weekly_metrics.js
 * Auto-run: Monday night wake per CLAUDE.md protocol
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile as execFileNode } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFileNode);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const WORKSPACE_PATH = path.join(PROJECT_ROOT, 'workspace');

// ─── Week boundaries ─────────────────────────────────────────────────────────

function getWeekDates() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-CA', { timeZone: tz });

  // ISO week: Monday=start. Find this Monday.
  const dayOfWeek = today.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + mondayOffset + i);
    dates.push(d.toLocaleDateString('en-CA', { timeZone: tz }));
  }
  return { dates, today: todayStr };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pct(n, total) {
  return total > 0 ? `${Math.round(n / total * 100)}%` : 'n/a';
}

/**
 * Returns ISO week key string for a date string "YYYY-MM-DD".
 * Format: "2026-W15" — stable sort key for chronological ordering.
 */
function getISOWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // shift to Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Load all engagement log months from the engagement directory.
 * Returns flat array of all engagement entries across all available months.
 */
async function loadAllEngagements() {
  const engDir = path.join(WORKSPACE_PATH, 'logs', 'engagement');
  let files = [];
  try {
    files = await fs.readdir(engDir);
  } catch { return []; }

  const all = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(engDir, file), 'utf-8'));
      if (Array.isArray(raw)) all.push(...raw);
    } catch { /* corrupt — skip */ }
  }
  return all;
}

/**
 * Build per-ISO-week theory interlocutor counts from all available engagement data.
 * Returns { byWeek: { "2026-W14": 3 }, weekDates: { "2026-W14": { "2026-04-04": 117 } } }
 */
function buildTheoryTrendByWeek(allEngagements) {
  const byWeek = {};
  const weekDates = {}; // weekKey -> { dateStr -> count } — for backfill spike detection
  for (const e of allEngagements) {
    if (!e.theory_interlocutor || !e.timestamp) continue;
    const dateStr = e.timestamp.split('T')[0];
    const weekKey = getISOWeekKey(dateStr);
    byWeek[weekKey] = (byWeek[weekKey] || 0) + 1;
    if (!weekDates[weekKey]) weekDates[weekKey] = {};
    weekDates[weekKey][dateStr] = (weekDates[weekKey][dateStr] || 0) + 1;
  }
  return { byWeek, weekDates };
}

const BACKFILL_SPIKE_THRESHOLD = 20;

/**
 * Detect possible backfill spikes in prior weeks.
 * If a single date in a prior week has >BACKFILL_SPIKE_THRESHOLD theory_interlocutor entries,
 * flag it — a bulk tagging run on one day inflates the weekly count misleadingly.
 * Returns: { weekKey -> { date, count } } for affected weeks only.
 */
function detectBackfillSpikes(priorWeekKeys, weekDates) {
  const spikes = {};
  for (const weekKey of priorWeekKeys) {
    const dates = weekDates[weekKey] || {};
    const entries = Object.entries(dates).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0 && entries[0][1] > BACKFILL_SPIKE_THRESHOLD) {
      spikes[weekKey] = { date: entries[0][0], count: entries[0][1] };
    }
  }
  return spikes;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { dates: weekDates, today } = getWeekDates();
  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];
  const month = weekEnd.substring(0, 7); // YYYY-MM

  console.log(`\n╔══════════════════════════════════════════════════╗`);
  console.log(`  Weekly Metrics: ${weekStart} → ${weekEnd}`);
  console.log(`  (Generated: ${today})`);
  console.log(`╚══════════════════════════════════════════════════╝\n`);

  // ── 1. Plans / Wakes ────────────────────────────────────────────────────────
  const plansPath = path.join(WORKSPACE_PATH, 'plans');
  let plans = [];
  try {
    const files = await fs.readdir(plansPath);
    for (const file of files) {
      const dateStr = file.split('_')[0];
      if (!weekDates.includes(dateStr) || !file.endsWith('.json')) continue;
      try {
        const content = JSON.parse(await fs.readFile(path.join(plansPath, file), 'utf-8'));
        plans.push({ file, ...content });
      } catch { /* corrupt plan — skip */ }
    }
  } catch {
    console.log('  [plans] No plans directory found');
  }

  const totalWakes = plans.length;
  const theoryPraxis = plans.filter(p => p.theory_praxis && p.theory_praxis !== 'none').length;
  const boldYes = plans.filter(p => p.bold_check && /^yes/i.test(p.bold_check)).length;
  const improveWakes = plans.filter(p =>
    p.tasks && p.tasks.some(t => t.type === 'improve' && t.status === 'done')
  ).length;
  const studyWakes = plans.filter(p =>
    p.tasks && p.tasks.some(t => t.type === 'study' && t.status === 'done')
  ).length;

  console.log('── Wakes ────────────────────────────────────────────');
  console.log(`  Total this week:          ${totalWakes}`);
  console.log(`  Theory-praxis connected:  ${theoryPraxis}/${totalWakes} (${pct(theoryPraxis, totalWakes)})`);
  console.log(`  Bold wakes:               ${boldYes}/${totalWakes}`);
  console.log(`  Improvement wakes:        ${improveWakes}/${totalWakes}`);
  console.log(`  Study wakes:              ${studyWakes}/${totalWakes}`);
  if (theoryPraxis / Math.max(totalWakes, 1) < 0.5) {
    console.log(`  ⚠  Theory-praxis rate below 50% — schedule more study sessions`);
  }
  console.log('');

  // ── 2. Engagement Log ──────────────────────────────────────────────────────
  // Load this week's engagements (from current month files)
  const engPath = path.join(WORKSPACE_PATH, 'logs', 'engagement', `${month}.json`);
  const mastoEngPath = path.join(WORKSPACE_PATH, 'logs', 'engagement', `mastodon-${month}.json`);
  let weekEngagements = [];
  try {
    const raw = JSON.parse(await fs.readFile(engPath, 'utf-8'));
    weekEngagements.push(...raw.filter(e => weekDates.includes((e.timestamp || '').split('T')[0])));
  } catch { /* no Bluesky log yet */ }
  try {
    const raw = JSON.parse(await fs.readFile(mastoEngPath, 'utf-8'));
    weekEngagements.push(...raw.filter(e => weekDates.includes((e.timestamp || '').split('T')[0])));
  } catch { /* no Mastodon log yet */ }

  // Load ALL engagement data (across all months) for trend computation
  const allEngagements = await loadAllEngagements();
  const { byWeek: theoryByWeekMap, weekDates: theoryByDateMap } = buildTheoryTrendByWeek(allEngagements);
  const thisWeekKey = getISOWeekKey(weekStart);
  // Prior weeks: all keys before this week, sorted chronologically
  const priorWeekKeys = Object.keys(theoryByWeekMap)
    .filter(k => k < thisWeekKey)
    .sort();
  const theoryTrendPrior = priorWeekKeys.map(k => theoryByWeekMap[k]);
  const backfillSpikes = detectBackfillSpikes(priorWeekKeys, theoryByDateMap);
  const thisWeekTheoryCount = theoryByWeekMap[thisWeekKey] || 0;

  const distinctHandles = new Set(weekEngagements.map(e => e.handle)).size;
  const byType = {};
  for (const e of weekEngagements) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  const typeStr = Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none';

  // Signal weight: reply/mention are deeper engagement than boost/favourite.
  // Weights: reply=3, mention=2, reblog/boost=1, favourite=1, follow=0
  const SIGNAL_WEIGHTS = { reply: 3, mention: 2, reblog: 1, boost: 1, favourite: 1, follow: 0 };
  function signalWeight(type) {
    return SIGNAL_WEIGHTS[type] ?? 1;
  }

  // Theory interlocutor engagements — known deep-theory conversation partners
  const theoryEngagements = weekEngagements.filter(e => e.theory_interlocutor === true);
  const theoryHandles = [...new Set(theoryEngagements.map(e => e.unified_id || e.handle))];
  const theoryByType = {};
  for (const e of theoryEngagements) {
    theoryByType[e.type] = (theoryByType[e.type] || 0) + 1;
  }
  const theoryTypeStr = Object.entries(theoryByType).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none';

  // Weighted theory interlocutor score — reply counts more than a boost
  const theoryWeightedScore = theoryEngagements.reduce((sum, e) => sum + signalWeight(e.type), 0);

  // Per-handle weighted scores — surfaces who's engaging deeply vs. just amplifying
  const theoryByHandle = {};
  for (const e of theoryEngagements) {
    const key = e.unified_id || e.handle;
    if (!theoryByHandle[key]) theoryByHandle[key] = { raw: 0, weighted: 0 };
    theoryByHandle[key].raw += 1;
    theoryByHandle[key].weighted += signalWeight(e.type);
  }
  const theoryHandleStr = Object.entries(theoryByHandle)
    .sort((a, b) => b[1].weighted - a[1].weighted)
    .map(([h, s]) => `${h}(w:${s.weighted})`)
    .join(', ') || 'none';

  console.log('── Engagement ───────────────────────────────────────');
  console.log(`  Total incoming:           ${weekEngagements.length}`);
  console.log(`  Distinct handles:         ${distinctHandles}`);
  console.log(`  By type:                  ${typeStr}`);
  console.log(`  Theory interlocutors:     ${theoryEngagements.length} raw / ${theoryWeightedScore} weighted`);
  if (theoryEngagements.length > 0) {
    console.log(`    by type:                ${theoryTypeStr}`);
    console.log(`    by handle (weighted):   ${theoryHandleStr}`);
    const tRate = pct(theoryEngagements.length, weekEngagements.length);
    console.log(`    share of total:         ${tRate}`);
  }
  // Theory interlocutor trend: compare this week vs prior ISO weeks
  if (priorWeekKeys.length > 0) {
    const prevCount = theoryTrendPrior[theoryTrendPrior.length - 1]; // most recent prior week
    const arrow = thisWeekTheoryCount > prevCount ? '↑' : thisWeekTheoryCount < prevCount ? '↓' : '→';
    const priorStr = theoryTrendPrior.join('/');
    console.log(`    trend (vs prior weeks): ${arrow} ${thisWeekTheoryCount} (was ${priorStr})`);
    for (const [weekKey, spike] of Object.entries(backfillSpikes)) {
      console.log(`    ⚠ ${weekKey}: ${theoryByWeekMap[weekKey]} (spike: ${spike.count} on ${spike.date}, possible backfill)`);
    }
  }
  if (theoryEngagements.length === 0 && distinctHandles > 0) {
    console.log(`  ⚠  No theory interlocutor engagement this week`);
  }
  if (distinctHandles === 0) {
    console.log(`  ⚠  No organizer contacts this week`);
  }

  // Theory resonance score — organizer-instance-weighted amplification signal.
  // A reblog from kolektiva.social (3pts) is qualitatively different from
  // an anonymous mstdn.social boost (1pt). Groups mastodon engagement entries
  // with resonance_pts by status_url; distinguishes organizing-space spread vs
  // general amplification.
  const mastodonEngDir = path.join(WORKSPACE_PATH, 'logs', 'engagement');
  let mastodonEngagements = [];
  try {
    const engFiles = await fs.readdir(mastodonEngDir);
    for (const file of engFiles) {
      if (!file.startsWith('mastodon-') || !file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(mastodonEngDir, file), 'utf-8'));
        if (Array.isArray(raw)) mastodonEngagements.push(...raw);
      } catch { /* corrupt — skip */ }
    }
  } catch { /* no dir yet */ }

  const weekMastoEngagements = mastodonEngagements.filter(e =>
    e.timestamp && weekDates.includes(e.timestamp.split('T')[0]) && e.resonance_pts
  );

  if (weekMastoEngagements.length > 0) {
    // Group by status_url — each post's total resonance score
    const resonanceByPost = {};
    for (const e of weekMastoEngagements) {
      const key = e.status_url || e.status_id || 'unknown';
      if (!resonanceByPost[key]) resonanceByPost[key] = { total: 0, organizer: 0, general: 0, count: 0 };
      resonanceByPost[key].total += e.resonance_pts;
      resonanceByPost[key].count += 1;
      if (e.resonance_pts >= 3) resonanceByPost[key].organizer += 1;
      else resonanceByPost[key].general += 1;
    }
    const topPosts = Object.entries(resonanceByPost)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 3);
    const totalResonance = weekMastoEngagements.reduce((s, e) => s + e.resonance_pts, 0);
    const organizerPts = weekMastoEngagements.filter(e => e.resonance_pts >= 3).reduce((s, e) => s + e.resonance_pts, 0);
    console.log(`  Theory resonance score:   ${totalResonance} total (${organizerPts} from organizer instances)`);
    for (const [url, s] of topPosts) {
      const shortUrl = url.length > 60 ? url.slice(-40) : url;
      console.log(`    ${shortUrl}: score ${s.total} (${s.organizer} organizer + ${s.general} general boosts)`);
    }
  } else {
    console.log(`  Theory resonance score:   no resonance_pts data yet (fires next wake forward)`);
  }
  console.log('');

  // ── 3. Posts Log ───────────────────────────────────────────────────────────
  const postsPath = path.join(WORKSPACE_PATH, 'logs', 'posts', `${month}.json`);
  let weekPosts = [];
  try {
    const raw = JSON.parse(await fs.readFile(postsPath, 'utf-8'));
    weekPosts = raw.filter(p => weekDates.includes((p.posted_at || '').split('T')[0]));
  } catch { /* no log yet */ }

  const allTags = weekPosts.flatMap(p => p.hashtags || []);
  const tagCounts = {};
  for (const tag of allTags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  console.log('── Posts ────────────────────────────────────────────');
  console.log(`  Total posts:              ${weekPosts.length}`);
  if (topTags.length > 0) {
    console.log(`  Top hashtags:             ${topTags.map(([t, n]) => `${t}(${n})`).join(', ')}`);
  }
  console.log('');

  // ── 4. resources.md update frequency ───────────────────────────────────────
  let resourceCommits = null;
  try {
    const result = await execFileAsync('git', [
      'log', '--since=7 days ago', '--oneline', '--', 'workspace/resources.md'
    ], { cwd: PROJECT_ROOT });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    resourceCommits = lines.length;
  } catch { /* git unavailable */ }

  console.log('── Resources ────────────────────────────────────────');
  if (resourceCommits === null) {
    console.log(`  resources.md commits:     (git unavailable)`);
  } else {
    console.log(`  resources.md commits (7d): ${resourceCommits}`);
    if (resourceCommits === 0) {
      console.log(`  ⚠  resources.md had zero commits this week — flagging`);
    }
  }
  console.log('');

  // ── 5. Solidarity Log ──────────────────────────────────────────────────────
  const solidarityPath = path.join(WORKSPACE_PATH, 'logs', 'solidarity', `${month}.json`);
  let solidarityActions = 0;
  try {
    const raw = JSON.parse(await fs.readFile(solidarityPath, 'utf-8'));
    solidarityActions = raw.filter(e => weekDates.includes((e.date || '').split('T')[0])).length;
  } catch { /* no log yet */ }

  console.log('── Solidarity Crawl ─────────────────────────────────');
  console.log(`  Actions logged this week: ${solidarityActions}`);
  console.log('');

  // ── Summary ────────────────────────────────────────────────────────────────
  const tpRate = pct(theoryPraxis, totalWakes);
  console.log('── Summary ──────────────────────────────────────────');
  console.log(`  Theory-praxis rate:       ${tpRate} (target >50%)`);
  console.log(`  Organizer contacts:       ${distinctHandles}`);
  console.log(`  Theory interlocutor eng.: ${theoryEngagements.length} raw / ${theoryWeightedScore} weighted (${theoryHandleStr})`);
  if (priorWeekKeys.length > 0) {
    const prevCount = theoryTrendPrior[theoryTrendPrior.length - 1];
    const arrow = thisWeekTheoryCount > prevCount ? '↑' : thisWeekTheoryCount < prevCount ? '↓' : '→';
    console.log(`  Theory eng. trend:        ${arrow} ${thisWeekTheoryCount} (was ${theoryTrendPrior.join('/')})`);
    for (const [weekKey, spike] of Object.entries(backfillSpikes)) {
      console.log(`    ⚠ ${weekKey}: ${theoryByWeekMap[weekKey]} (spike: ${spike.count} on ${spike.date}, possible backfill)`);
    }
  }
  console.log(`  Posts published:          ${weekPosts.length}`);
  console.log(`  Improvements shipped:     ${improveWakes}`);
  console.log('');
}

main().catch(err => {
  console.error(`[weekly-metrics] Error: ${err.message}`);
  process.exit(1);
});
