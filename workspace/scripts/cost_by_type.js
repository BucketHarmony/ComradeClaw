#!/usr/bin/env node
/**
 * cost_by_type.js — Summarize wake costs by type for a given date (or today).
 *
 * Usage:
 *   node workspace/scripts/cost_by_type.js [--date YYYY-MM-DD] [--days N]
 *
 * --days N: show N days aggregated (default: today only)
 * --date: override today's date
 *
 * Output: per-type cost + token estimate breakdown, sorted by cost descending
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WAKE_LOG_DIR = path.join(__dirname, '..', 'logs', 'wakes');
const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function dateRange(days) {
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toLocaleDateString('en-CA', { timeZone: tz }));
  }
  return dates;
}

async function loadCosts(dateStr) {
  try {
    const f = path.join(WAKE_LOG_DIR, `${dateStr}_costs.json`);
    return JSON.parse(await fs.readFile(f, 'utf-8'));
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 1;
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const dates = dateArg ? [dateArg] : dateRange(daysArg);

const byType = {};
let grandTotal = 0;
let grandTokens = 0;
let grandCount = 0;

for (const d of dates) {
  const data = await loadCosts(d);
  if (!data) continue;
  for (const e of data.entries || []) {
    const key = e.source || 'unknown';
    if (!byType[key]) byType[key] = { cost: 0, count: 0, tokens: 0, runaway: 0 };
    byType[key].cost += e.cost || 0;
    byType[key].count += 1;
    byType[key].tokens += e.total_tokens_est || 0;
    if ((e.total_tokens_est || 0) > 50000) byType[key].runaway += 1;
    grandTotal += e.cost || 0;
    grandTokens += e.total_tokens_est || 0;
    grandCount += 1;
  }
}

// Sort by cost descending
const sorted = Object.entries(byType).sort((a, b) => b[1].cost - a[1].cost);

const dateLabel = dates.length === 1 ? dates[0] : `${dates[dates.length - 1]} → ${dates[0]}`;
console.log(`\n== Wake Cost Breakdown: ${dateLabel} ==\n`);
console.log(`${'Type'.padEnd(20)} ${'Count'.padStart(5)} ${'Cost'.padStart(8)} ${'Avg Cost'.padStart(10)} ${'Tokens(est)'.padStart(13)} ${'Runaway'.padStart(8)}`);
console.log('-'.repeat(70));

for (const [type, s] of sorted) {
  const avgCost = s.count > 0 ? (s.cost / s.count) : 0;
  const avgTokens = s.count > 0 ? Math.round(s.tokens / s.count) : 0;
  const runFlag = s.runaway > 0 ? `${s.runaway}⚠️` : '-';
  console.log(
    `${type.padEnd(20)} ${String(s.count).padStart(5)} $${s.cost.toFixed(4).padStart(7)} $${avgCost.toFixed(4).padStart(9)} ${String(avgTokens > 0 ? `~${avgTokens}` : '-').padStart(13)} ${runFlag.padStart(8)}`
  );
}

console.log('-'.repeat(70));
const avgTok = grandCount > 0 ? Math.round(grandTokens / grandCount) : 0;
console.log(`${'TOTAL'.padEnd(20)} ${String(grandCount).padStart(5)} $${grandTotal.toFixed(4).padStart(7)} ${avgTok > 0 ? `avg ~${avgTok} tokens/wake` : ''}`);
console.log('');
if (grandTokens === 0) {
  console.log('Note: token estimates not yet in this cost file — will populate after next wake.');
}
