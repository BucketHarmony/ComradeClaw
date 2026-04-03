#!/usr/bin/env node
/**
 * cost_audit.js
 *
 * Compares per-wake cost fields in wake logs (YYYY-MM-DD.json) against
 * the accumulated cost totals in cost files (YYYY-MM-DD_costs.json).
 *
 * Surfaces discrepancies caused by timezone mismatches, restarts, or
 * mid-day process failures. Writes results to:
 *   workspace/logs/system_tests/cost_audit.json
 *
 * Usage:
 *   node workspace/scripts/cost_audit.js [YYYY-MM-DD]
 *   (defaults to today in America/Detroit)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const WAKE_LOG_DIR = path.join(PROJECT_ROOT, 'workspace', 'logs', 'wakes');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'workspace', 'logs', 'system_tests', 'cost_audit.json');
const TZ = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

async function auditDate(dateStr) {
  const wakeLogPath = path.join(WAKE_LOG_DIR, `${dateStr}.json`);
  const costsPath = path.join(WAKE_LOG_DIR, `${dateStr}_costs.json`);

  const result = {
    date: dateStr,
    wake_log: { found: false, wake_count: 0, wake_cost_sum: 0, wakes: [] },
    costs_file: { found: false, total: 0, wake_entries: 0, chat_entries: 0, entry_sum: 0 },
    discrepancy: null,
    verdict: null
  };

  // Read wake log
  try {
    const wakeLog = JSON.parse(await fs.readFile(wakeLogPath, 'utf-8'));
    result.wake_log.found = true;
    result.wake_log.wake_count = wakeLog.wakes?.length || 0;
    for (const w of (wakeLog.wakes || [])) {
      const c = w.cost || 0;
      result.wake_log.wake_cost_sum += c;
      result.wake_log.wakes.push({ label: w.label, time: w.time, cost: c });
    }
  } catch {
    result.wake_log.found = false;
  }

  // Read costs file
  try {
    const costsData = JSON.parse(await fs.readFile(costsPath, 'utf-8'));
    result.costs_file.found = true;
    result.costs_file.total = costsData.total || 0;

    let entrySum = 0;
    for (const e of (costsData.entries || [])) {
      entrySum += e.cost || 0;
      if (e.source === 'chat') result.costs_file.chat_entries++;
      else result.costs_file.wake_entries++;
    }
    result.costs_file.entry_sum = entrySum;

    // Wake-only sum from costs file (exclude chat)
    result.costs_file.wake_cost_sum = (costsData.entries || [])
      .filter(e => e.source !== 'chat')
      .reduce((acc, e) => acc + (e.cost || 0), 0);
  } catch {
    result.costs_file.found = false;
  }

  // Calculate discrepancy: wake log sum vs costs file wake sum
  if (result.wake_log.found && result.costs_file.found) {
    const wakeSum = result.wake_log.wake_cost_sum;
    const costWakeSum = result.costs_file.wake_cost_sum;
    const diff = Math.abs(wakeSum - costWakeSum);
    result.discrepancy = {
      wake_log_sum: parseFloat(wakeSum.toFixed(6)),
      costs_file_wake_sum: parseFloat(costWakeSum.toFixed(6)),
      difference: parseFloat(diff.toFixed(6)),
      significant: diff > 0.001
    };

    if (diff < 0.001) {
      result.verdict = 'PASS — wake log and costs file agree within $0.001';
    } else {
      result.verdict = `MISMATCH — wake log: $${wakeSum.toFixed(4)}, costs file wakes: $${costWakeSum.toFixed(4)}, diff: $${diff.toFixed(4)}`;
    }
  } else if (!result.wake_log.found && !result.costs_file.found) {
    result.verdict = 'NO DATA — neither file found for this date';
  } else if (!result.wake_log.found) {
    result.verdict = 'NO WAKE LOG — costs file exists but wake log missing';
  } else {
    result.verdict = 'NO COSTS FILE — wake log exists but costs file missing (possible restart/date mismatch)';
  }

  return result;
}

async function run() {
  const targetDate = process.argv[2] || today();
  console.log(`[cost_audit] Auditing: ${targetDate}`);

  const result = await auditDate(targetDate);

  // Also check yesterday for cross-date leakage (night wake timezone issue)
  const [y, m, d] = targetDate.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  const prevStr = prev.toLocaleDateString('en-CA', { timeZone: TZ });
  const prevResult = await auditDate(prevStr);

  const report = {
    run_at: new Date().toISOString(),
    audit_date: targetDate,
    results: [result, prevResult]
  };

  // Write output
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2));

  // Print summary
  for (const r of report.results) {
    const sig = r.discrepancy?.significant ? ' ⚠️' : '';
    console.log(`[cost_audit] ${r.date}: ${r.verdict}${sig}`);
    if (r.wake_log.found) {
      console.log(`  Wake log: ${r.wake_log.wake_count} wakes, $${r.wake_log.wake_cost_sum.toFixed(4)} total`);
    }
    if (r.costs_file.found) {
      console.log(`  Costs file: ${r.costs_file.wake_entries} wake entries ($${r.costs_file.wake_cost_sum?.toFixed(4)}), ${r.costs_file.chat_entries} chat entries, total $${r.costs_file.total.toFixed(4)}`);
    }
  }

  console.log(`[cost_audit] Report written to: ${OUTPUT_FILE}`);
}

run().catch(err => {
  console.error(`[cost_audit] Error: ${err.message}`);
  process.exit(1);
});
