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

  const distinctHandles = new Set(weekEngagements.map(e => e.handle)).size;
  const byType = {};
  for (const e of weekEngagements) {
    byType[e.type] = (byType[e.type] || 0) + 1;
  }
  const typeStr = Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none';

  // Theory interlocutor engagements — known deep-theory conversation partners
  const theoryEngagements = weekEngagements.filter(e => e.theory_interlocutor === true);
  const theoryHandles = [...new Set(theoryEngagements.map(e => e.unified_id || e.handle))];
  const theoryByType = {};
  for (const e of theoryEngagements) {
    theoryByType[e.type] = (theoryByType[e.type] || 0) + 1;
  }
  const theoryTypeStr = Object.entries(theoryByType).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none';

  console.log('── Engagement ───────────────────────────────────────');
  console.log(`  Total incoming:           ${weekEngagements.length}`);
  console.log(`  Distinct handles:         ${distinctHandles}`);
  console.log(`  By type:                  ${typeStr}`);
  console.log(`  Theory interlocutors:     ${theoryEngagements.length} (${theoryHandles.join(', ') || 'none'})`);
  if (theoryEngagements.length > 0) {
    console.log(`    by type:                ${theoryTypeStr}`);
    const tRate = pct(theoryEngagements.length, weekEngagements.length);
    console.log(`    share of total:         ${tRate}`);
  }
  if (theoryEngagements.length === 0 && distinctHandles > 0) {
    console.log(`  ⚠  No theory interlocutor engagement this week`);
  }
  if (distinctHandles === 0) {
    console.log(`  ⚠  No organizer contacts this week`);
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
  console.log(`  Theory interlocutor eng.: ${theoryEngagements.length} (${theoryHandles.join(', ') || 'none'})`);
  console.log(`  Posts published:          ${weekPosts.length}`);
  console.log(`  Improvements shipped:     ${improveWakes}`);
  console.log('');
}

main().catch(err => {
  console.error(`[weekly-metrics] Error: ${err.message}`);
  process.exit(1);
});
