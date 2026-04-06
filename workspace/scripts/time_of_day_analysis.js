#!/usr/bin/env node
/**
 * time_of_day_analysis.js
 *
 * Karpathy Loop: do organizers reply more to morning posts vs evening posts?
 * For each time_of_day bucket (morning/afternoon/evening/night), compute:
 *   organizer_reply_rate = organizer_engagements_attributed / posts_in_bucket
 *
 * Platform-aware attribution:
 *   - Bluesky engagements (no platform field) → matched against Bluesky posts only (uri starts at://)
 *   - Mastodon engagements (platform='mastodon') → matched against multipost/mastodon posts
 *     using time-window against logged_at; time_of_day derived from hour when missing
 *   Each engagement is attributed to exactly ONE post (first match wins).
 *
 * Reads:  workspace/logs/posts/*.json + workspace/logs/engagement/*.json
 * Writes: workspace/logs/analysis/time_of_day_analysis.json
 *
 * Run: node workspace/scripts/time_of_day_analysis.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, '../../');
const POSTS_DIR   = join(ROOT, 'workspace/logs/posts');
const ENG_DIR     = join(ROOT, 'workspace/logs/engagement');
const OUTPUT_DIR  = join(ROOT, 'workspace/logs/analysis');
const OUTPUT_PATH = join(OUTPUT_DIR, 'time_of_day_analysis.json');
const WINDOW_MS   = 48 * 60 * 60 * 1000;

const BUCKETS = ['morning', 'afternoon', 'evening', 'night'];

// Time-of-day derivation from UTC hour (matches dispatcher.js logic)
const DETROIT_OFFSET = -4; // EDT (UTC-4 in April)
function hourToTimeOfDay(utcHour) {
  const local = ((utcHour + DETROIT_OFFSET) + 24) % 24;
  if (local >= 5  && local < 12) return 'morning';
  if (local >= 12 && local < 17) return 'afternoon';
  if (local >= 17 && local < 21) return 'evening';
  return 'night';
}

function loadJsonFiles(dir, prefix = null) {
  let results = [];
  try {
    let files = readdirSync(dir).filter(f => f.endsWith('.json'));
    if (prefix) files = files.filter(f => f.startsWith(prefix));
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      results = results.concat(Array.isArray(raw) ? raw : []);
    }
  } catch {
    // dir may not exist yet
  }
  return results;
}

// Normalize a post entry: ensure posted_at and time_of_day are populated.
function normalizePost(entry) {
  const posted_at = entry.posted_at || entry.logged_at;
  let time_of_day = entry.time_of_day;
  if (!time_of_day || !BUCKETS.includes(time_of_day)) {
    // Derive from posted_at timestamp
    time_of_day = posted_at
      ? hourToTimeOfDay(new Date(posted_at).getUTCHours())
      : 'unknown';
  }
  // Detect platform
  const platform = entry.platform ||
    (typeof entry.uri === 'string' && entry.uri.startsWith('at://') ? 'bluesky' :
     entry.type === 'multipost' || entry.type === 'multithread' ? 'multi' : 'bluesky');
  return { ...entry, posted_at, time_of_day, platform };
}

function run() {
  // Load all posts; separate by platform for attribution
  const rawPosts      = loadJsonFiles(POSTS_DIR);
  const posts         = rawPosts.map(normalizePost);
  const bskyPosts     = posts.filter(p => p.platform === 'bluesky');
  const mastodonPosts = posts.filter(p => p.platform === 'multi' || p.platform === 'mastodon');

  // Load engagements by platform
  const bskyEngagements = loadJsonFiles(ENG_DIR)
    .filter(e => !e.platform || e.platform === 'bluesky');
  const mastodonEngagements = loadJsonFiles(ENG_DIR)
    .filter(e => e.platform === 'mastodon');

  const allPosts = [...bskyPosts, ...mastodonPosts];
  if (allPosts.length === 0) {
    console.log('No post data yet.');
    return;
  }

  // Build postEngMap keyed by a stable ID
  const postEngMap = new Map();
  for (const p of allPosts) {
    const key = p.uri || p.posted_at;
    postEngMap.set(key, {
      bucket:   p.time_of_day,
      platform: p.platform,
      counts:   { organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 },
      details:  [],
    });
  }

  // Direct respondent attribution (when post.respondents populated)
  const directPosts = allPosts.filter(p => Array.isArray(p.respondents) && p.checked_at);
  for (const post of directPosts) {
    const key   = post.uri || post.posted_at;
    const entry = postEngMap.get(key);
    if (!entry) continue;
    for (const r of post.respondents) {
      const cls = r.classification || 'unclassified';
      entry.counts[cls] = (entry.counts[cls] || 0) + 1;
      entry.details.push({ handle: r.handle, class: cls, source: 'direct' });
    }
  }

  // Time-window attribution — Bluesky engagements → Bluesky posts only
  const bskyWindowPosts = bskyPosts.filter(p => !Array.isArray(p.respondents) || !p.checked_at);
  for (const eng of bskyEngagements) {
    const engTime = new Date(eng.timestamp).getTime();
    const match = bskyWindowPosts.find(p => {
      const pt = new Date(p.posted_at).getTime();
      return engTime >= pt && engTime <= pt + WINDOW_MS;
    });
    if (!match) continue;
    const key   = match.uri || match.posted_at;
    const entry = postEngMap.get(key);
    if (!entry) continue;
    const cls = eng.classification || 'unclassified';
    entry.counts[cls] = (entry.counts[cls] || 0) + 1;
    entry.details.push({ handle: eng.handle, class: cls, source: 'time-window' });
  }

  // Time-window attribution — Mastodon engagements → multipost/mastodon posts only
  const mastoWindowPosts = mastodonPosts.filter(p => !Array.isArray(p.respondents) || !p.checked_at);
  for (const eng of mastodonEngagements) {
    const engTime = new Date(eng.timestamp).getTime();
    const match = mastoWindowPosts.find(p => {
      const pt = new Date(p.posted_at).getTime();
      return engTime >= pt && engTime <= pt + WINDOW_MS;
    });
    if (!match) continue;
    const key   = match.uri || match.posted_at;
    const entry = postEngMap.get(key);
    if (!entry) continue;
    const cls = eng.classification || 'unclassified';
    entry.counts[cls] = (entry.counts[cls] || 0) + 1;
    entry.details.push({ handle: eng.handle, class: cls, source: 'time-window' });
  }

  // Aggregate by bucket
  const bucketAccum = {};
  for (const b of [...BUCKETS, 'unknown']) {
    bucketAccum[b] = { postCount: 0, counts: { organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 }, details: [] };
  }
  for (const p of allPosts) {
    const b = BUCKETS.includes(p.time_of_day) ? p.time_of_day : 'unknown';
    bucketAccum[b].postCount++;
  }
  for (const [, entry] of postEngMap) {
    const b = BUCKETS.includes(entry.bucket) ? entry.bucket : 'unknown';
    const acc = bucketAccum[b];
    for (const [cls, n] of Object.entries(entry.counts)) {
      acc.counts[cls] = (acc.counts[cls] || 0) + n;
    }
    acc.details.push(...entry.details);
  }

  const bucketStats = [];
  for (const bucket of BUCKETS) {
    const acc   = bucketAccum[bucket];
    const total = Object.values(acc.counts).reduce((a, b) => a + b, 0);
    const organizerRate = acc.postCount > 0
      ? Math.round((acc.counts.organizer / acc.postCount) * 1000) / 1000
      : null;

    bucketStats.push({
      bucket,
      post_count:            acc.postCount,
      total_engagements:     total,
      organizer_engagements: acc.counts.organizer,
      organizer_reply_rate:  organizerRate,
      by_class:              acc.counts,
      note:                  acc.postCount === 0 ? 'no posts in this bucket' : null,
    });
  }

  const ranked   = [...bucketStats].sort((a, b) => (b.organizer_reply_rate ?? -1) - (a.organizer_reply_rate ?? -1));
  const bestBucket = ranked[0]?.organizer_reply_rate !== null ? ranked[0].bucket : 'insufficient data';

  const totalAttributed = bucketStats.reduce((s, b) => s + b.total_engagements, 0);
  const unmatchedMastodon = mastodonEngagements.length - bucketStats.reduce((s, b) => s + b.by_class.organizer, 0);
  // More accurate unmatched: total eng - attributed
  const unmatched = (bskyEngagements.length + mastodonEngagements.length) - totalAttributed;

  const output = {
    generated_at:       new Date().toISOString(),
    attribution_window_hours: 48,
    total_posts:        allPosts.length,
    bluesky_posts:      bskyPosts.length,
    mastodon_posts:     mastodonPosts.length,
    bluesky_engagements:  bskyEngagements.length,
    mastodon_engagements: mastodonEngagements.length,
    unmatched_engagements: unmatched,
    buckets:            bucketStats,
    interpretation: {
      metric:      'organizer_reply_rate = organizer_engagements / posts_in_bucket',
      best_bucket: bestBucket,
      unmatched_note: unmatched > 0
        ? `${unmatched} engagements unmatched — likely Mastodon engagements on posts logged before mastodon_post logging was added.`
        : 'all engagements attributed',
      note: allPosts.length < 20
        ? `Small dataset (${allPosts.length} posts). Rates directional only; need ≥5 posts/bucket.`
        : `Dataset: ${allPosts.length} posts.`,
    },
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\nTime-of-Day Organizer Reply Rate — ${output.generated_at}`);
  console.log(`Posts: ${allPosts.length} (BS:${bskyPosts.length} Masto:${mastodonPosts.length}) | Engagements: BS=${bskyEngagements.length} Masto=${mastodonEngagements.length}`);
  console.log('\nBucket breakdown:');
  for (const b of bucketStats) {
    const rate = b.organizer_reply_rate !== null ? b.organizer_reply_rate.toFixed(3) : 'no data';
    const bar  = b.organizer_reply_rate !== null
      ? '█'.repeat(Math.min(40, Math.round(b.organizer_reply_rate * 20)))
      : '';
    console.log(`  ${b.bucket.padEnd(12)}: rate=${rate.padStart(6)} ${bar.padEnd(42)}| posts=${b.post_count} org=${b.organizer_engagements} total_eng=${b.total_engagements}`);
  }
  console.log(`\nBest bucket: ${bestBucket}`);
  if (allPosts.length < 20) console.log(`⚠ Small dataset — treat as directional.`);
  console.log(`Written: ${OUTPUT_PATH}`);
}

run();
