#!/usr/bin/env node
/**
 * post_engagement_analysis.js
 *
 * Karpathy Loop feedback: join post log with classified engagement log.
 * For each engagement, find the post(s) made in the preceding 48 hours.
 * Report: which posts drove which organizer replies (vs general/ai-agent/bot).
 *
 * Output: workspace/logs/analysis/post_engagement_YYYY-MM.json
 *
 * Run: node workspace/scripts/post_engagement_analysis.js
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../');

const POSTS_DIR = join(ROOT, 'workspace/logs/posts');
const ENGAGEMENT_DIR = join(ROOT, 'workspace/logs/engagement');
const OUTPUT_DIR = join(ROOT, 'workspace/logs/analysis');
const WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

function loadJsonFiles(dir) {
  let results = [];
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      results = results.concat(Array.isArray(raw) ? raw : []);
    }
  } catch (e) {
    // dir may not exist yet
  }
  return results;
}

function run() {
  const posts = loadJsonFiles(POSTS_DIR);
  const engagements = loadJsonFiles(ENGAGEMENT_DIR);

  if (posts.length === 0) {
    console.log('No post data found. Run bluesky_post at least once.');
    return;
  }
  if (engagements.length === 0) {
    console.log('No engagement data found. Run read_replies at least once.');
    return;
  }

  // Sort posts by time ascending
  posts.sort((a, b) => new Date(a.posted_at) - new Date(b.posted_at));

  // For each engagement, find posts in the 48h before it
  const correlations = [];

  for (const eng of engagements) {
    const engTime = new Date(eng.timestamp).getTime();
    const windowStart = engTime - WINDOW_MS;

    const candidatePosts = posts.filter(p => {
      const pt = new Date(p.posted_at).getTime();
      return pt >= windowStart && pt <= engTime;
    });

    correlations.push({
      engagement: {
        timestamp: eng.timestamp,
        handle: eng.handle,
        classification: eng.classification || 'unclassified',
        type: eng.type,
        text_snippet: eng.text_snippet,
        uri: eng.uri,
      },
      candidate_posts: candidatePosts.map(p => ({
        uri: p.uri,
        posted_at: p.posted_at,
        type: p.type,
        char_count: p.char_count,
        hashtags: p.hashtags || [],
        time_of_day: p.time_of_day,
        hours_before: Math.round((new Date(eng.timestamp) - new Date(p.posted_at)) / 3600000 * 10) / 10,
      })),
    });
  }

  // Summary: per-post, which classifications engaged
  const postMap = {};
  for (const c of correlations) {
    for (const p of c.candidate_posts) {
      if (!postMap[p.uri]) {
        postMap[p.uri] = {
          uri: p.uri,
          posted_at: p.posted_at,
          type: p.type,
          char_count: p.char_count,
          hashtags: p.hashtags,
          time_of_day: p.time_of_day,
          engagements: { organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 },
          engagement_detail: [],
        };
      }
      const cls = c.engagement.classification || 'unclassified';
      if (postMap[p.uri].engagements[cls] !== undefined) {
        postMap[p.uri].engagements[cls]++;
      } else {
        postMap[p.uri].engagements[cls] = 1;
      }
      postMap[p.uri].engagement_detail.push({
        handle: c.engagement.handle,
        classification: cls,
        hours_after: p.hours_before,
        text_snippet: c.engagement.text_snippet,
      });
    }
  }

  // Hashtag summary: which hashtags correlate with organizer replies
  const hashtagSummary = {};
  for (const p of Object.values(postMap)) {
    for (const tag of p.hashtags) {
      if (!hashtagSummary[tag]) {
        hashtagSummary[tag] = { tag, posts: 0, organizer: 0, 'ai-agent': 0, general: 0, bot: 0, unclassified: 0 };
      }
      hashtagSummary[tag].posts++;
      for (const [cls, count] of Object.entries(p.engagements)) {
        hashtagSummary[tag][cls] = (hashtagSummary[tag][cls] || 0) + count;
      }
    }
  }

  // Engagements with no candidate posts (posted before tracking started)
  const orphaned = correlations.filter(c => c.candidate_posts.length === 0);

  const output = {
    generated_at: new Date().toISOString(),
    post_count: posts.length,
    engagement_count: engagements.length,
    correlated_count: correlations.filter(c => c.candidate_posts.length > 0).length,
    orphaned_count: orphaned.length,
    note_orphaned: orphaned.length > 0
      ? `${orphaned.length} engagements had no post within 48h preceding — likely before post logging started`
      : null,
    post_summary: Object.values(postMap).sort(
      (a, b) => (b.engagements.organizer - a.engagements.organizer)
    ),
    hashtag_summary: Object.values(hashtagSummary).sort(
      (a, b) => b.organizer - a.organizer
    ),
    raw_correlations: correlations,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Write to YYYY-MM file
  const month = new Date().toISOString().slice(0, 7);
  const outPath = join(OUTPUT_DIR, `post_engagement_${month}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\nPost-Engagement Analysis — ${new Date().toISOString()}`);
  console.log(`Posts: ${posts.length} | Engagements: ${engagements.length}`);
  console.log(`Correlated: ${output.correlated_count} | Orphaned: ${output.orphaned_count}`);
  console.log('\nPer-post engagement breakdown:');
  for (const p of output.post_summary) {
    const tags = p.hashtags.join(', ') || 'no hashtags';
    console.log(`  [${p.time_of_day}] ${tags} → organizer:${p.engagements.organizer} ai-agent:${p.engagements['ai-agent']} general:${p.engagements.general}`);
  }
  console.log('\nHashtag → organizer correlation:');
  for (const h of output.hashtag_summary) {
    console.log(`  ${h.tag}: ${h.organizer} organizer / ${h.general} general / ${h['ai-agent']} ai-agent (${h.posts} posts)`);
  }
  console.log(`\nWritten: ${outPath}`);
}

run();
