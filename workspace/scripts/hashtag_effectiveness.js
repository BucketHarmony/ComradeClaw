#!/usr/bin/env node
/**
 * hashtag_effectiveness.js
 *
 * Karpathy Loop signal: not engagement volume, but engagement quality.
 * For each hashtag used in posts, measure what classifications engaged.
 * signal_quality = organizer_engagements / total_engagements.
 *
 * Reads: workspace/logs/posts/*.json + workspace/logs/engagement/*.json
 * Writes: workspace/logs/analysis/hashtag_effectiveness.json
 *
 * Run: node workspace/scripts/hashtag_effectiveness.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../');

const POSTS_DIR   = join(ROOT, 'workspace/logs/posts');
const ENG_DIR     = join(ROOT, 'workspace/logs/engagement');
const OUTPUT_DIR  = join(ROOT, 'workspace/logs/analysis');
const OUTPUT_PATH = join(OUTPUT_DIR, 'hashtag_effectiveness.json');
const WINDOW_MS   = 48 * 60 * 60 * 1000; // 48h attribution window

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

// Normalize a post entry to have a hashtags array.
// multipost/multithread entries store hashtags inline in text — extract them.
function normalizePost(entry) {
  if (entry.hashtags && Array.isArray(entry.hashtags)) return entry;
  const texts = [
    ...(Array.isArray(entry.posts) ? entry.posts : []),
    entry.bluesky_text || '',
    entry.mastodon_text || '',
  ];
  const hashtags = [...new Set(
    texts.flatMap(t => (t.match(/#[A-Za-z][A-Za-z0-9_]*/g) || []))
  )];
  const posted_at = entry.logged_at || entry.posted_at;
  return { ...entry, hashtags, posted_at };
}

function run() {
  const rawPosts    = loadJsonFiles(POSTS_DIR);
  const posts       = rawPosts.map(normalizePost);
  const engagements = loadJsonFiles(ENG_DIR);

  if (posts.length === 0) {
    console.log('No post data. Run bluesky_post at least once.');
    return;
  }

  // Build hashtag → posts map
  const hashtagPosts = {}; // tag → [post]
  for (const p of posts) {
    for (const tag of (p.hashtags || [])) {
      if (!hashtagPosts[tag]) hashtagPosts[tag] = [];
      hashtagPosts[tag].push(p);
    }
  }

  const allTags = Object.keys(hashtagPosts);
  if (allTags.length === 0) {
    console.log('No hashtag data in posts log.');
    return;
  }

  // For each hashtag, find engagements within 48h of any post using it
  const tagStats = [];

  for (const tag of allTags) {
    const tagPostList = hashtagPosts[tag];
    const counts = { organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 };
    const engagementDetails = [];

    for (const eng of engagements) {
      const engTime = new Date(eng.timestamp).getTime();
      // Is this engagement within 48h after any post with this hashtag?
      const matchingPost = tagPostList.find(p => {
        const pt = new Date(p.posted_at).getTime();
        return engTime >= pt && engTime <= pt + WINDOW_MS;
      });
      if (!matchingPost) continue;

      const cls = eng.classification || 'unclassified';
      counts[cls] = (counts[cls] || 0) + 1;
      engagementDetails.push({
        handle:      eng.handle,
        class:       cls,
        hours_after: Math.round((engTime - new Date(matchingPost.posted_at).getTime()) / 3600000 * 10) / 10,
        snippet:     eng.text_snippet,
      });
    }

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const signalQuality = total > 0 ? Math.round((counts.organizer / total) * 1000) / 1000 : null;

    tagStats.push({
      hashtag:        tag,
      posts:          tagPostList.length,
      total_engagements: total,
      signal_quality: signalQuality, // null = no data yet
      by_class:       counts,
      engagements:    engagementDetails,
      note:           total === 0 ? 'no engagements attributed yet' : null,
    });
  }

  // Sort: organizer count desc, then total desc
  tagStats.sort((a, b) =>
    (b.by_class.organizer - a.by_class.organizer) ||
    (b.total_engagements - a.total_engagements)
  );

  const output = {
    generated_at:    new Date().toISOString(),
    attribution_window_hours: 48,
    post_count:      posts.length,
    engagement_count: engagements.length,
    hashtag_count:   allTags.length,
    summary:         tagStats,
    interpretation: {
      signal_quality: 'organizer_engagements / total_engagements (null = no data)',
      karpathy_signal: 'maximize signal_quality, not total_engagements',
      current_best:   tagStats[0]?.hashtag || 'no data',
      organizer_replies_total: tagStats.reduce((s, t) => s + t.by_class.organizer, 0),
    },
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  console.log(`\nHashtag Effectiveness — ${output.generated_at}`);
  console.log(`Posts: ${output.post_count} | Engagements: ${output.engagement_count}`);
  console.log('\nHashtag quality breakdown:');
  for (const t of tagStats) {
    const sq = t.signal_quality !== null ? t.signal_quality.toFixed(3) : 'no data';
    console.log(`  ${t.hashtag}: signal_quality=${sq} | organizer=${t.by_class.organizer} ai-agent=${t.by_class['ai-agent']} general=${t.by_class.general} (${t.posts} posts, ${t.total_engagements} total)`);
  }
  console.log(`\nKarpathy signal: maximize organizer engagements, not volume.`);
  console.log(`Organizer replies total: ${output.interpretation.organizer_replies_total}`);
  console.log(`Written: ${OUTPUT_PATH}`);
}

run();
