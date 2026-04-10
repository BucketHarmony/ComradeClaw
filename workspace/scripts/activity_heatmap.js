#!/usr/bin/env node
/**
 * activity_heatmap.js
 *
 * Organizer-density heatmap: when are organizers most active by hour and weekday?
 *
 * Reads last 30 days of engagement logs (Bluesky + Mastodon), builds a
 * 7×24 weekday×hour matrix of organizer-weighted interactions.
 * Writes workspace/logs/analytics/activity_heatmap.json with:
 *   - full matrix
 *   - top 3 posting windows
 *   - summary string for wake context injection
 *
 * Weighting:
 *   organizer classification → 2.0
 *   theory_interlocutor (non-organizer) → 1.5
 *   ai-agent → 0.5 (signal but not organizing weight)
 *   general → 1.0
 *
 * Timestamps converted to America/Detroit local time (EDT = UTC-4 in April/May).
 *
 * Run: node workspace/scripts/activity_heatmap.js
 * Auto-run: spawned by getOrganizerActivityHeatmap() in dispatcher.js when stale (>6h).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '../../');
const ENG_DIR   = join(ROOT, 'workspace/logs/engagement');
const OUT_DIR   = join(ROOT, 'workspace/logs/analytics');
const OUT_PATH  = join(OUT_DIR, 'activity_heatmap.json');

// America/Detroit: EDT = UTC-4 (March–November), EST = UTC-5 (Nov–March)
// We'll use a simple offset based on current month — good enough for this window
const DETROIT_OFFSET_HOURS = -4; // EDT (April–October)

const DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

// Per-handle cap: one interlocutor with 100 engagements in a single hour
// shouldn't drown out 10 distinct organizers active at another time.
// Cap each handle's contribution to MAX_HANDLE_WEIGHT per (weekday, hour) slot.
const MAX_HANDLE_WEIGHT = 1.0;

// Organizer weight by classification
const WEIGHTS = {
  organizer:    2.0,
  general:      1.0,
  'ai-agent':   0.5,
  bot:          0.0,
  unclassified: 0.5,
};
const THEORY_BONUS = 0.5; // added on top of base weight when theory_interlocutor=true

function getWeight(entry) {
  const cls    = entry.classification || 'unclassified';
  const base   = WEIGHTS[cls] ?? 0.5;
  const theory = entry.theory_interlocutor ? THEORY_BONUS : 0;
  return base + theory;
}

/**
 * Convert UTC timestamp to Detroit local {weekday, hour}.
 * weekday: 0=Sun … 6=Sat
 * hour: 0–23 local
 */
function toLocalSlot(isoTimestamp) {
  const msUTC     = new Date(isoTimestamp).getTime();
  if (isNaN(msUTC)) return null;
  const msLocal   = msUTC + DETROIT_OFFSET_HOURS * 60 * 60 * 1000;
  const localDate = new Date(msLocal);
  return {
    weekday: localDate.getUTCDay(),   // UTC day of the shifted time = local day
    hour:    localDate.getUTCHours(), // UTC hours of the shifted time = local hours
  };
}

function loadEngagements() {
  const cutoff = Date.now() - THIRTY_DAYS;
  let entries  = [];
  try {
    const files = readdirSync(ENG_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(ENG_DIR, file), 'utf8'));
        if (Array.isArray(raw)) {
          entries = entries.concat(raw);
        }
      } catch {
        // skip malformed files
      }
    }
  } catch {
    // engagement dir doesn't exist yet
  }
  // Filter to last 30 days by timestamp
  return entries.filter(e => {
    const ts = e.timestamp || e.logged_at;
    return ts && new Date(ts).getTime() >= cutoff;
  });
}

function run() {
  const engagements = loadEngagements();

  // Build 7×24 matrix: matrix[weekday][hour] = { weight, count, handles: Set }
  const matrix = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ weight: 0, count: 0, handles: new Set() }))
  );

  // Per-handle budget tracking: handleBudget[weekday][hour][handle] = weight_already_applied
  // Enforces MAX_HANDLE_WEIGHT cap — prevents single-burst outliers from collapsing the matrix.
  const handleBudget = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({}))
  );

  let skipped = 0;
  let capped  = 0;
  for (const eng of engagements) {
    const ts   = eng.timestamp || eng.logged_at;
    const slot = toLocalSlot(ts);
    if (!slot) { skipped++; continue; }

    const w = getWeight(eng);
    if (w <= 0) continue; // bots don't count

    const handle    = eng.handle || '?';
    const budget    = handleBudget[slot.weekday][slot.hour];
    const used      = budget[handle] || 0;
    const remaining = MAX_HANDLE_WEIGHT - used;
    if (remaining <= 0) { capped++; continue; } // handle maxed out for this slot

    const contribution = Math.min(w, remaining);
    budget[handle] = used + contribution;

    const cell = matrix[slot.weekday][slot.hour];
    cell.weight += contribution;
    cell.count  += 1;
    cell.handles.add(handle);
  }

  // Flatten matrix for output (Sets → counts for JSON)
  const matrixOut = matrix.map((row, wd) =>
    row.map((cell, hr) => ({
      weekday:       wd,
      weekday_name:  DAY_NAMES[wd],
      hour:          hr,
      weight:        Math.round(cell.weight * 100) / 100,
      count:         cell.count,
      unique_handles: cell.handles.size,
    }))
  );

  // Find top posting windows: top 3 cells by weight
  const allCells = matrixOut.flat().filter(c => c.weight > 0);
  allCells.sort((a, b) => b.weight - a.weight);
  const top3 = allCells.slice(0, 3);

  // Also find top 3 hours (collapsed across weekdays)
  const hourTotals = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    weight: matrixOut.reduce((sum, row) => sum + row[h].weight, 0),
    count:  matrixOut.reduce((sum, row) => sum + row[h].count, 0),
  }));
  hourTotals.sort((a, b) => b.weight - a.weight);
  const topHours = hourTotals.slice(0, 3).filter(h => h.weight > 0);

  // Build human-readable hour label (12h format local)
  function hourLabel(h) {
    const suffix = h >= 12 ? 'pm' : 'am';
    const h12    = h % 12 || 12;
    return `${h12}${suffix}`;
  }

  // Summary string for wake context
  let summary = '';
  if (topHours.length > 0) {
    const parts = topHours.map(h => `${hourLabel(h.hour)} EDT (weight=${h.weight.toFixed(1)})`);
    summary = `Top organizer-active hours: ${parts.join(', ')}`;
    if (top3.length > 0) {
      const t = top3[0];
      summary += `. Peak slot: ${DAY_NAMES[t.weekday]} ${hourLabel(t.hour)} EDT`;
    }
  } else {
    summary = 'Insufficient data for heatmap (need more engagement logs)';
  }

  const output = {
    generated_at:      new Date().toISOString(),
    window_days:       30,
    total_entries:     engagements.length,
    skipped:           skipped,
    capped:            capped,
    handle_weight_cap: MAX_HANDLE_WEIGHT,
    timezone:          'America/Detroit (EDT, UTC-4)',
    weights:           { organizer: 2.0, 'theory_interlocutor_bonus': 0.5, general: 1.0, 'ai-agent': 0.5, bot: 0.0, unclassified: 0.5 },
    top_3_windows:     top3,
    top_3_hours:       topHours.slice(0, 3),
    summary,
    matrix:            matrixOut,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\nOrganizer Activity Heatmap — ${output.generated_at}`);
  console.log(`Engagements: ${engagements.length} (${skipped} skipped, ${capped} capped by handle limit) | Window: last 30 days`);
  console.log(`\nTop 3 posting windows:`);
  for (const w of top3) {
    console.log(`  ${DAY_NAMES[w.weekday]} ${String(w.hour).padStart(2, '0')}:00 local — weight=${w.weight.toFixed(2)} count=${w.count} handles=${w.unique_handles}`);
  }
  console.log(`\nTop 3 hours (all weekdays):`);
  for (const h of topHours.slice(0, 3)) {
    const bar = '█'.repeat(Math.min(30, Math.round(h.weight)));
    console.log(`  ${String(h.hour).padStart(2, '0')}:00 (${hourLabel(h.hour)}) — weight=${h.weight.toFixed(2)} ${bar}`);
  }
  console.log(`\n${summary}`);
  console.log(`Written: ${OUT_PATH}`);
}

run();
