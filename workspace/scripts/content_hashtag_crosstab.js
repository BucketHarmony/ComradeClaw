#!/usr/bin/env node
/**
 * content_hashtag_crosstab.js — Content-Type × Hashtag Cross-Analysis
 *
 * Closes the Karpathy loop at the intersection of format and signal:
 * not just "use #AIMutualAid" but "theory-grounded posts with #AIMutualAid."
 *
 * Reads:
 *   workspace/logs/posts/*.json          — Bluesky posts (with content_type + hashtags)
 *   workspace/logs/posts/mastodon-*.json — Mastodon posts (same fields)
 *   workspace/logs/engagement/*.json     — Engagement classification records
 *
 * Writes:
 *   workspace/logs/analysis/content_hashtag_crosstab.json
 *
 * GUARD: Requires ≥3 (content_type, hashtag) pairs to report a pair.
 *        Requires ≥20 total posts with both fields to consider results meaningful.
 *
 * Usage: node workspace/scripts/content_hashtag_crosstab.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../');

const POSTS_DIR   = join(ROOT, 'workspace/logs/posts');
const ENG_DIR     = join(ROOT, 'workspace/logs/engagement');
const OUTPUT_DIR  = join(ROOT, 'workspace/logs/analysis');
const OUTPUT_PATH = join(OUTPUT_DIR, 'content_hashtag_crosstab.json');

const MIN_PAIR_POSTS  = 3;   // minimum posts per (content_type, hashtag) pair
const MIN_TOTAL_POSTS = 20;  // dataset viability threshold
const WINDOW_MS = 48 * 60 * 60 * 1000; // 48h attribution window

function loadJsonFiles(dir) {
  let results = [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      results = results.concat(Array.isArray(raw) ? raw : []);
    }
  } catch {
    // dir may not exist yet
  }
  return results;
}

// Normalize a post to always have: hashtags[], content_type, posted_at
function normalizePost(entry) {
  const texts = [
    ...(Array.isArray(entry.posts) ? entry.posts : []),
    entry.bluesky_text || '',
    entry.mastodon_text || '',
    entry.text || '',
  ];
  const hashtags = entry.hashtags && Array.isArray(entry.hashtags)
    ? entry.hashtags
    : [...new Set(texts.flatMap(t => (t.match(/#[A-Za-z][A-Za-z0-9_]*/g) || [])))];
  const posted_at = entry.posted_at || entry.logged_at;
  return { ...entry, hashtags, posted_at };
}

// Attribute engagements to a post.
// Uses direct respondents if available, falls back to 48h time window.
function attributeEngagements(post, allEngagements) {
  // Direct attribution (retrospective linkback ran for this post)
  if (Array.isArray(post.respondents) && post.checked_at) {
    return post.respondents.map(r => ({
      classification: r.classification || 'unclassified',
      source: 'direct',
    }));
  }

  // Time-window fallback
  if (!post.posted_at) return [];
  const pt = new Date(post.posted_at).getTime();
  return allEngagements
    .filter(e => {
      const et = new Date(e.timestamp).getTime();
      return et >= pt && et <= pt + WINDOW_MS;
    })
    .map(e => ({
      classification: e.classification || 'unclassified',
      source: 'time-window',
    }));
}

function run() {
  const rawPosts    = loadJsonFiles(POSTS_DIR);
  const engagements = loadJsonFiles(ENG_DIR);
  const posts       = rawPosts.map(normalizePost).filter(p => p.content_type && p.hashtags.length > 0);

  console.log('=== Content-Type × Hashtag Cross-Analysis ===');
  console.log(`Posts with content_type + hashtags: ${posts.length} / ${rawPosts.length} total`);
  console.log(`Engagement records: ${engagements.length}`);
  console.log(`Guard thresholds: ≥${MIN_PAIR_POSTS} posts/pair, ≥${MIN_TOTAL_POSTS} total posts\n`);

  if (posts.length < MIN_TOTAL_POSTS) {
    console.log(`⚠ Dataset too small (${posts.length}/${MIN_TOTAL_POSTS}). Results unreliable.`);
    console.log('Keep posting and run again. This script will still output what pairs exist.\n');
  }

  // Build (content_type, hashtag) → [post] map
  const pairMap = {}; // "content_type::hashtag" → { content_type, hashtag, posts[] }

  for (const post of posts) {
    for (const tag of post.hashtags) {
      const key = `${post.content_type}::${tag}`;
      if (!pairMap[key]) pairMap[key] = { content_type: post.content_type, hashtag: tag, posts: [] };
      pairMap[key].posts.push(post);
    }
  }

  const allPairs = Object.values(pairMap);
  const qualifiedPairs = allPairs.filter(p => p.posts.length >= MIN_PAIR_POSTS);

  console.log(`Unique (content_type, hashtag) pairs: ${allPairs.length}`);
  console.log(`Pairs with ≥${MIN_PAIR_POSTS} posts: ${qualifiedPairs.length}\n`);

  // Compute signal quality for each qualified pair
  const results = [];
  for (const pair of allPairs) {
    const counts = { organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 };
    let directCount = 0;
    let windowCount = 0;

    for (const post of pair.posts) {
      const attributed = attributeEngagements(post, engagements);
      for (const e of attributed) {
        counts[e.classification] = (counts[e.classification] || 0) + 1;
        if (e.source === 'direct') directCount++;
        else windowCount++;
      }
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const signalQuality = total > 0 ? Math.round((counts.organizer / total) * 1000) / 1000 : null;
    const qualified = pair.posts.length >= MIN_PAIR_POSTS;

    let attributionMethod;
    if (directCount > 0 && windowCount === 0) attributionMethod = 'direct';
    else if (directCount === 0 && windowCount > 0) attributionMethod = 'time-window';
    else if (directCount > 0 && windowCount > 0) attributionMethod = 'mixed';
    else attributionMethod = 'none';

    results.push({
      content_type: pair.content_type,
      hashtag: pair.hashtag,
      post_count: pair.posts.length,
      qualified,
      total_engagements: total,
      signal_quality: signalQuality,
      by_class: counts,
      attribution: attributionMethod,
    });
  }

  // Sort: qualified first, then signal_quality desc, then organizer count desc
  results.sort((a, b) => {
    if (a.qualified !== b.qualified) return b.qualified - a.qualified;
    const sqA = a.signal_quality ?? -1;
    const sqB = b.signal_quality ?? -1;
    if (sqB !== sqA) return sqB - sqA;
    return b.by_class.organizer - a.by_class.organizer;
  });

  // Print results
  if (qualifiedPairs.length === 0) {
    console.log('No pairs qualify yet. All pairs (unqualified):');
    for (const r of results) {
      console.log(`  ${r.content_type} × ${r.hashtag}: ${r.post_count}/${MIN_PAIR_POSTS} posts needed`);
    }
  } else {
    console.log('--- Qualified pairs (≥' + MIN_PAIR_POSTS + ' posts each) ---');
    for (const r of results.filter(r => r.qualified)) {
      const sq = r.signal_quality !== null ? r.signal_quality.toFixed(3) : 'no data';
      const attr = r.attribution === 'direct' ? '[direct]' : r.attribution === 'mixed' ? '[mixed]' : '[window]';
      console.log(
        `  ${r.content_type} × ${r.hashtag}: signal_quality=${sq} ${attr}` +
        ` | organizer=${r.by_class.organizer} / total=${r.total_engagements} (${r.post_count} posts)`
      );
    }

    // Summary: best pair per content_type
    const contentTypes = [...new Set(qualifiedPairs.map(p => p.content_type))];
    console.log('\n--- Best hashtag per content type (qualified only) ---');
    for (const ct of contentTypes) {
      const best = results.filter(r => r.qualified && r.content_type === ct)
        .sort((a, b) => (b.signal_quality ?? -1) - (a.signal_quality ?? -1))[0];
      if (best) {
        const sq = best.signal_quality !== null ? best.signal_quality.toFixed(3) : 'no data';
        console.log(`  ${ct}: best = ${best.hashtag} (signal_quality=${sq}, n=${best.post_count})`);
      }
    }

    // Karpathy recommendation
    const topPair = results.filter(r => r.qualified && r.signal_quality !== null)
      .sort((a, b) => (b.signal_quality ?? -1) - (a.signal_quality ?? -1))[0];
    if (topPair) {
      console.log(`\nKarpathy recommendation: ${topPair.content_type} posts with ${topPair.hashtag}`);
      console.log(`  signal_quality=${topPair.signal_quality.toFixed(3)} | n=${topPair.post_count} | organizer=${topPair.by_class.organizer}`);
    }
  }

  // Show unqualified pairs that are close to threshold
  const almostQualified = results.filter(r => !r.qualified && r.post_count >= Math.max(1, MIN_PAIR_POSTS - 1));
  if (almostQualified.length > 0) {
    console.log(`\n--- Almost qualified (${MIN_PAIR_POSTS - 1}/${MIN_PAIR_POSTS} posts) ---`);
    for (const r of almostQualified) {
      console.log(`  ${r.content_type} × ${r.hashtag}: ${r.post_count} posts (need ${MIN_PAIR_POSTS - r.post_count} more)`);
    }
  }

  // Dataset viability
  const viable = posts.length >= MIN_TOTAL_POSTS;
  console.log(`\nDataset viability: ${viable ? '✓ VIABLE' : `✗ NOT VIABLE (${posts.length}/${MIN_TOTAL_POSTS})`}`);
  console.log(`Written: ${OUTPUT_PATH}`);

  // Write output
  const output = {
    generated_at: new Date().toISOString(),
    dataset_viable: viable,
    post_count_with_fields: posts.length,
    engagement_count: engagements.length,
    min_pair_posts: MIN_PAIR_POSTS,
    min_total_posts: MIN_TOTAL_POSTS,
    qualified_pair_count: qualifiedPairs.length,
    pairs: results,
    interpretation: {
      signal_quality: 'organizer_engagements / total_engagements (null = no engagements attributed)',
      karpathy_signal: 'maximize signal_quality × pair, not just hashtag or content_type alone',
      top_pair: results.find(r => r.qualified && r.signal_quality !== null) || null,
      content_types_seen: [...new Set(posts.map(p => p.content_type))],
      hashtags_seen: [...new Set(posts.flatMap(p => p.hashtags))],
    },
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
}

run();
