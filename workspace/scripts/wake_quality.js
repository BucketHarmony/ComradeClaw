#!/usr/bin/env node
/**
 * wake_quality.js — Objective wake quality scorer
 *
 * Scores each wake plan file on 5 dimensions (max 12 points):
 *   improvements_committed  0-2  (tasks type=improve, status=done)
 *   posts_made              0-3  (posts log entries for that date, type=post/thread)
 *   theory_praxis           0-2  (plan field != "none"/empty)
 *   solidarity_actions      0-2  (engage tasks with like/repost/boost/reply verbs)
 *   organizer_engagements   0-3  (engagement log entries classified=organizer on that date)
 *
 * Usage:
 *   node workspace/scripts/wake_quality.js [--days 7] [--date 2026-04-04]
 *   node workspace/scripts/wake_quality.js --weekly-summary   (for sunday-metrics injection)
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');
const PLANS_DIR = join(ROOT, 'workspace/plans');
const POSTS_DIR = join(ROOT, 'workspace/logs/posts');
const ENGAGEMENT_DIR = join(ROOT, 'workspace/logs/engagement');

const args = process.argv.slice(2);
const DAYS = (() => {
  const i = args.indexOf('--days');
  return i >= 0 ? parseInt(args[i + 1], 10) : 7;
})();
const TARGET_DATE = (() => {
  const i = args.indexOf('--date');
  return i >= 0 ? args[i + 1] : null;
})();
const WEEKLY_SUMMARY = args.includes('--weekly-summary');

// ── helpers ────────────────────────────────────────────────────────────────

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function dateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function getPlanFilesForDate(date) {
  if (!existsSync(PLANS_DIR)) return [];
  return readdirSync(PLANS_DIR)
    .filter(f => f.startsWith(date) && f.endsWith('.json'))
    .map(f => join(PLANS_DIR, f));
}

function getPostsForDate(date) {
  // Posts log is YYYY-MM.json; filter by posted_at date
  const ym = date.slice(0, 7);
  const log = readJson(join(POSTS_DIR, `${ym}.json`));
  if (!Array.isArray(log)) return [];
  return log.filter(p => p.posted_at && p.posted_at.startsWith(date));
}

function getEngagementsForDate(date) {
  const ym = date.slice(0, 7);
  const bsky = readJson(join(ENGAGEMENT_DIR, `${ym}.json`)) || [];
  const masto = readJson(join(ENGAGEMENT_DIR, `mastodon-${ym}.json`)) || [];
  const all = [...bsky, ...masto];
  return all.filter(e => e.timestamp && e.timestamp.startsWith(date));
}

// ── scoring ────────────────────────────────────────────────────────────────

function scoreWake(plan) {
  const scores = {
    improvements_committed: 0,
    posts_made: 0,
    theory_praxis: 0,
    solidarity_actions: 0,
    organizer_engagements: 0,
  };
  const notes = {};

  // improvements_committed (0-2)
  const improveTasks = (plan.tasks || []).filter(
    t => t.type === 'improve' && t.status === 'done'
  );
  scores.improvements_committed = Math.min(2, improveTasks.length);
  notes.improvements = improveTasks.map(t => t.summary?.slice(0, 60)).filter(Boolean);

  // theory_praxis (0-2)
  const tp = plan.theory_praxis || '';
  scores.theory_praxis = (tp && tp !== 'none' && tp.trim().length > 4) ? 2 : 0;
  notes.theory_praxis = tp.slice(0, 80);

  // solidarity_actions (0-2): engage tasks with action verbs
  const engageTasks = (plan.tasks || []).filter(t => t.type === 'engage');
  const solidarityVerbs = /liked|boosted|reposted|favourited|replied|retweeted/i;
  let verbCount = 0;
  engageTasks.forEach(t => {
    const summary = t.summary || '';
    const matches = summary.match(solidarityVerbs);
    if (matches) verbCount += matches.length;
  });
  scores.solidarity_actions = verbCount >= 4 ? 2 : verbCount >= 1 ? 1 : 0;

  return { scores, notes };
}

function scoreDateBatch(date, planPaths) {
  if (planPaths.length === 0) return null;

  const posts = getPostsForDate(date);
  const engagements = getEngagementsForDate(date);
  const organizerEngagements = engagements.filter(e => e.classification === 'organizer');

  // Aggregate across all plan files for the day
  let totalImprovements = 0;
  let totalSolidarityVerbs = 0;
  let hasTheoryPraxis = false;
  const allNotes = { improvements: [], theory_praxis: '' };

  for (const path of planPaths) {
    const plan = readJson(path);
    if (!plan) continue;

    const { scores, notes } = scoreWake(plan);
    totalImprovements += scores.improvements_committed;
    totalSolidarityVerbs += (scores.solidarity_actions > 0 ? scores.solidarity_actions : 0);
    if (scores.theory_praxis > 0) {
      hasTheoryPraxis = true;
      allNotes.theory_praxis = notes.theory_praxis;
    }
    allNotes.improvements.push(...notes.improvements);
  }

  // Compute final daily scores
  const originalPostsCount = posts.filter(p => p.type === 'post' || p.type === 'thread').length;
  const scores = {
    improvements_committed: Math.min(2, totalImprovements),
    posts_made: Math.min(3, originalPostsCount),
    theory_praxis: hasTheoryPraxis ? 2 : 0,
    solidarity_actions: Math.min(2, totalSolidarityVerbs),
    organizer_engagements: Math.min(3, organizerEngagements.length),
  };

  const total = Object.values(scores).reduce((a, b) => a + b, 0);

  return {
    date,
    wakes: planPaths.length,
    scores,
    total,
    max: 12,
    pct: Math.round((total / 12) * 100),
    organizer_engagements: organizerEngagements.length,
    posts: originalPostsCount,
    notes: allNotes,
  };
}

// ── main ───────────────────────────────────────────────────────────────────

function run() {
  const dates = TARGET_DATE ? [TARGET_DATE] : dateRange(DAYS);

  const results = [];
  for (const date of dates) {
    const planPaths = getPlanFilesForDate(date);
    const result = scoreDateBatch(date, planPaths);
    if (result) results.push(result);
  }

  if (WEEKLY_SUMMARY) {
    outputWeeklySummary(results);
    return;
  }

  if (TARGET_DATE && results.length === 1) {
    outputDayDetail(results[0]);
    return;
  }

  outputTable(results);
}

function outputTable(results) {
  console.log('\n=== Wake Quality Scores ===');
  console.log(`${'Date'.padEnd(12)} ${'Wakes'.padEnd(6)} ${'Impr'.padEnd(5)} ${'Posts'.padEnd(6)} ${'ThPr'.padEnd(5)} ${'Soli'.padEnd(5)} ${'Org'.padEnd(4)} ${'Total'.padEnd(8)} Pct`);
  console.log('-'.repeat(70));

  let sumTotal = 0;
  let sumImpr = 0;
  let sumPosts = 0;
  let sumTp = 0;
  let sumSoli = 0;
  let sumOrg = 0;

  for (const r of results) {
    const s = r.scores;
    console.log(
      `${r.date.padEnd(12)} ${String(r.wakes).padEnd(6)} ${String(s.improvements_committed).padEnd(5)} ${String(s.posts_made).padEnd(6)} ${String(s.theory_praxis).padEnd(5)} ${String(s.solidarity_actions).padEnd(5)} ${String(s.organizer_engagements).padEnd(4)} ${`${r.total}/12`.padEnd(8)} ${r.pct}%`
    );
    sumTotal += r.total;
    sumImpr += s.improvements_committed;
    sumPosts += s.posts_made;
    sumTp += s.theory_praxis;
    sumSoli += s.solidarity_actions;
    sumOrg += s.organizer_engagements;
  }

  if (results.length > 1) {
    console.log('-'.repeat(70));
    const n = results.length;
    const avg = v => (v / n).toFixed(1);
    console.log(
      `${'Average'.padEnd(12)} ${''.padEnd(6)} ${avg(sumImpr).padEnd(5)} ${avg(sumPosts).padEnd(6)} ${avg(sumTp).padEnd(5)} ${avg(sumSoli).padEnd(5)} ${avg(sumOrg).padEnd(4)} ${avg(sumTotal) + '/12'}`
    );
    const weeklyPct = Math.round((sumTotal / (n * 12)) * 100);
    console.log(`\nWeekly score: ${sumTotal}/${n * 12} (${weeklyPct}%)`);
    console.log(`Avg organizer engagements/day: ${avg(sumOrg)}`);
    console.log(`Theory-praxis rate: ${Math.round((sumTp / (n * 2)) * 100)}%`);
  }
}

function outputDayDetail(r) {
  console.log(`\n=== Wake Quality: ${r.date} ===`);
  console.log(`Wakes: ${r.wakes}  |  Total: ${r.total}/12 (${r.pct}%)`);
  console.log('');
  console.log('Dimension scores:');
  Object.entries(r.scores).forEach(([k, v]) => {
    const max = k === 'posts_made' || k === 'organizer_engagements' ? (k === 'organizer_engagements' ? 3 : 3) : k === 'improvements_committed' ? 2 : 2;
    const bar = '█'.repeat(v) + '░'.repeat(max - v);
    console.log(`  ${k.padEnd(28)} ${bar}  ${v}/${max}`);
  });
  if (r.notes.theory_praxis) {
    console.log(`\nTheory-praxis: ${r.notes.theory_praxis}`);
  }
  if (r.notes.improvements.length > 0) {
    console.log('\nImprovements:');
    r.notes.improvements.forEach(n => console.log(`  • ${n}`));
  }
}

function outputWeeklySummary(results) {
  // Returns structured data for injection into sunday-metrics thread
  if (results.length === 0) {
    console.log(JSON.stringify({ error: 'no_data' }));
    return;
  }
  const n = results.length;
  const sumTotal = results.reduce((a, r) => a + r.total, 0);
  const sumOrg = results.reduce((a, r) => a + r.organizer_engagements, 0);
  const sumPosts = results.reduce((a, r) => a + r.posts, 0);
  const tpDays = results.filter(r => r.scores.theory_praxis > 0).length;
  const avgScore = (sumTotal / (n * 12) * 100).toFixed(0);
  const tpRate = Math.round((tpDays / n) * 100);

  const summary = {
    days_scored: n,
    avg_quality_pct: parseInt(avgScore),
    total_organizer_engagements: sumOrg,
    avg_organizer_per_day: (sumOrg / n).toFixed(1),
    theory_praxis_rate_pct: tpRate,
    total_original_posts: sumPosts,
    best_day: results.reduce((best, r) => r.total > best.total ? r : best).date,
    worst_day: results.reduce((worst, r) => r.total < worst.total ? r : worst).date,
    daily_scores: results.map(r => ({ date: r.date, score: r.total, pct: r.pct })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

run();
