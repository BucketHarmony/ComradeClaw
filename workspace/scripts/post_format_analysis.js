#!/usr/bin/env node
/**
 * post_format_analysis.js — Post Format Experiment Analysis
 *
 * Reads workspace/logs/posts/{YYYY-MM.json, mastodon-YYYY-MM.json}
 * Cross-references workspace/logs/engagement/{YYYY-MM.json, mastodon-YYYY-MM.json}
 * to measure which post formats (single vs thread, morning vs evening,
 * theory-grounded vs news-hook) correlate with organizer engagement.
 *
 * GUARD: Requires ≥10 examples in each condition before reporting.
 * Run this to check data readiness, not to draw premature conclusions.
 *
 * Usage: node workspace/scripts/post_format_analysis.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE = path.join(__dirname, '..', '..');
const POSTS_DIR = path.join(WORKSPACE, 'workspace', 'logs', 'posts');
const ENGAGEMENT_DIR = path.join(WORKSPACE, 'workspace', 'logs', 'engagement');

const MIN_EXAMPLES = 10; // Don't draw conclusions below this

async function readJsonFiles(dir, pattern) {
  const files = await fs.readdir(dir).catch(() => []);
  const matched = files.filter(f => pattern.test(f));
  const all = [];
  for (const file of matched) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8'));
      all.push(...(Array.isArray(data) ? data : []));
    } catch { /* skip corrupt files */ }
  }
  return all;
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = item[key] || 'unknown';
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

function checkGuard(groups, label) {
  const below = Object.entries(groups).filter(([, items]) => items.length < MIN_EXAMPLES);
  if (below.length > 0) {
    console.log(`  [${label}] NOT ENOUGH DATA — conditions below ${MIN_EXAMPLES}:`);
    below.forEach(([k, items]) => console.log(`    ${k}: ${items.length}/${MIN_EXAMPLES}`));
    return false;
  }
  return true;
}

async function main() {
  console.log('=== Post Format Experiment Analysis ===');
  console.log(`Guard: minimum ${MIN_EXAMPLES} examples per condition required\n`);

  // Load all posts (Bluesky + Mastodon)
  const bsPosts = await readJsonFiles(POSTS_DIR, /^\d{4}-\d{2}\.json$/);
  const maPosts = await readJsonFiles(POSTS_DIR, /^mastodon-\d{4}-\d{2}\.json$/);
  const allPosts = [
    ...bsPosts.map(p => ({ ...p, platform: p.platform || 'bluesky' })),
    ...maPosts.map(p => ({ ...p, platform: p.platform || 'mastodon' })),
  ].filter(p => p.content_type); // Only posts with the new content_type field

  console.log(`Total posts with content_type: ${allPosts.length} (BS: ${bsPosts.filter(p=>p.content_type).length}, MA: ${maPosts.filter(p=>p.content_type).length})`);

  if (allPosts.length === 0) {
    console.log('\nNo posts with content_type yet. This field was added in improve22.');
    console.log('Run this script again after posting 10+ times on each platform.');
    return;
  }

  // Load engagement
  const bsEng = await readJsonFiles(ENGAGEMENT_DIR, /^\d{4}-\d{2}\.json$/);
  const maEng = await readJsonFiles(ENGAGEMENT_DIR, /^mastodon-\d{4}-\d{2}\.json$/);
  const allEngagement = [...bsEng, ...maEng];

  // Build URI-to-organizer-engagement map
  const organizerEngByUri = {};
  for (const e of allEngagement) {
    const key = e.uri || e.status_id;
    if (!key) continue;
    if (!organizerEngByUri[key]) organizerEngByUri[key] = [];
    organizerEngByUri[key].push(e);
  }

  console.log(`\nEngagement records: ${allEngagement.length}`);

  // Attach engagement to posts via uri/id
  const postsWithEng = allPosts.map(p => {
    const key = p.uri || p.id;
    const eng = organizerEngByUri[key] || [];
    const organizerReplies = eng.filter(e => e.is_organizer || e.classified === true).length;
    return { ...p, engagements: eng.length, organizer_replies: organizerReplies };
  });

  console.log('\n--- Condition: FORMAT (single post vs thread) ---');
  const byFormat = groupBy(postsWithEng, 'type');
  // Normalize: 'post' → 'single'
  const formatGroups = {
    single: [...(byFormat.post || []), ...(byFormat.single || [])],
    thread: byFormat.thread || [],
  };
  const formatReady = checkGuard(formatGroups, 'format');
  if (formatReady) {
    for (const [fmt, items] of Object.entries(formatGroups)) {
      const orgRate = items.filter(p => p.organizer_replies > 0).length / items.length;
      console.log(`  ${fmt}: n=${items.length}, organizer_reply_rate=${(orgRate*100).toFixed(1)}%`);
    }
  }

  console.log('\n--- Condition: TIME OF DAY ---');
  const byTime = groupBy(postsWithEng, 'time_of_day');
  const timeReady = checkGuard(byTime, 'time_of_day');
  if (timeReady) {
    for (const [tod, items] of Object.entries(byTime)) {
      const orgRate = items.filter(p => p.organizer_replies > 0).length / items.length;
      console.log(`  ${tod}: n=${items.length}, organizer_reply_rate=${(orgRate*100).toFixed(1)}%`);
    }
  }

  console.log('\n--- Condition: CONTENT TYPE ---');
  const byContent = groupBy(postsWithEng, 'content_type');
  const contentReady = checkGuard(byContent, 'content_type');
  if (contentReady) {
    for (const [ct, items] of Object.entries(byContent)) {
      const orgRate = items.filter(p => p.organizer_replies > 0).length / items.length;
      console.log(`  ${ct}: n=${items.length}, organizer_reply_rate=${(orgRate*100).toFixed(1)}%`);
    }
  }

  console.log('\n--- Data Readiness Summary ---');
  const conditions = {
    format: { groups: formatGroups, ready: formatReady },
    time_of_day: { groups: byTime, ready: timeReady },
    content_type: { groups: byContent, ready: contentReady },
  };
  for (const [cond, { groups, ready }] of Object.entries(conditions)) {
    const counts = Object.entries(groups).map(([k, v]) => `${k}:${v.length}`).join(', ');
    console.log(`  ${cond}: ${ready ? '✓ READY' : '✗ NOT READY'} [${counts}]`);
  }
  const allReady = Object.values(conditions).every(c => c.ready);
  console.log(`\n${allReady ? '✓ All conditions met — analysis valid.' : '✗ Not enough data yet — keep posting and run again later.'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
