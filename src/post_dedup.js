/**
 * post_dedup.js — Cross-platform post deduplication
 *
 * Maintains a shared post log at workspace/logs/posts.json.
 * Every post to Bluesky or Mastodon is logged with:
 *   { platform, text_hash, timestamp, topic }
 *
 * Before posting, call checkCrossPlatformDuplicate(text) to detect
 * if similar content was posted to the OTHER platform in the last 24h.
 *
 * Trigram similarity (Jaccard on character 3-grams) catches paraphrased
 * repetition that hash matching misses. Threshold: 0.7 = warn, same-platform.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const SHARED_POSTS_LOG = path.join(WORKSPACE_PATH, 'logs', 'posts.json');

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Topic keywords — any of these in a post defines its topic bucket
const TOPIC_KEYWORDS = {
  cooperative: ['cooperative', 'co-op', 'coop', 'mondragon', 'worker-owned', 'worker owned'],
  mutual_aid: ['mutual aid', 'mutualaid', 'free fridge', 'free pantry', 'solidarity fridge', 'community fridge', 'mutual support'],
  labor: ['union', 'strike', 'labor', 'labour', 'worker', 'workplace', 'organizing', 'organizer', 'wage', 'uwua', 'afl-cio', 'iww'],
  dual_power: ['dual power', 'dualpower', 'counter-institution', 'prefigur', 'counter institution'],
  hampton: ['hampton', 'rainbow coalition', 'black panther', 'bpp', 'fred hampton'],
  theory: ['bordiga', 'goldman', 'luxemburg', 'trotsky', 'marx', 'falgsc', 'theory', 'praxis', 'dialectic'],
  mayday: ['mayday', 'may day', 'may 1', 'general strike', '#mayday', '#wcc26'],
  infrastructure: ['infrastructure', 'dual power', 'loan fund', 'credit union', 'childcare', 'food bank'],
};

/**
 * Compute Jaccard similarity between two texts using character 3-grams.
 * Returns 0.0–1.0. Values ≥ 0.7 indicate near-duplicate content.
 * Effective at catching paraphrased repetition that hash matching misses.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function trigramSimilarity(a, b) {
  const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.length < 3 || nb.length < 3) return 0.0;

  const trigrams = s => {
    const set = new Set();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };

  const ta = trigrams(na);
  const tb = trigrams(nb);
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0.0 : intersection / union;
}

/**
 * Hash the normalized first 120 chars of text.
 * Used for near-exact duplicate detection.
 */
export function hashText(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Extract topic bucket(s) from post text.
 * Returns array of matching topic names.
 */
export function extractTopics(text) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      matched.push(topic);
    }
  }
  return matched.length > 0 ? matched : ['general'];
}

/**
 * Append a post entry to the shared cross-platform log.
 * Called after every successful post or thread post.
 *
 * @param {string} platform - 'bluesky' or 'mastodon'
 * @param {string} text - full post text (or first post of thread)
 */
export async function logSharedPost(platform, text) {
  try {
    await fs.mkdir(path.dirname(SHARED_POSTS_LOG), { recursive: true });
    let entries = [];
    try {
      entries = JSON.parse(await fs.readFile(SHARED_POSTS_LOG, 'utf-8'));
    } catch { /* new file or parse error — start fresh */ }

    const entry = {
      platform,
      text_hash: hashText(text),
      timestamp: new Date().toISOString(),
      topic: extractTopics(text),
      text_preview: text.slice(0, 200).replace(/\n/g, ' '),
    };
    entries.push(entry);

    // Keep only last 200 entries to prevent unbounded growth
    if (entries.length > 200) entries = entries.slice(-200);

    await fs.writeFile(SHARED_POSTS_LOG, JSON.stringify(entries, null, 2));
  } catch { /* non-fatal — never block posting */ }
}

/**
 * Check whether similar content was posted to the OTHER platform in the last 24h.
 *
 * @param {string} platform - the platform you're ABOUT to post to
 * @param {string} text - the text you're about to post
 * @returns {{ duplicate: boolean, reason: string, match?: object }}
 */
export async function checkCrossPlatformDuplicate(platform, text) {
  try {
    const entries = JSON.parse(await fs.readFile(SHARED_POSTS_LOG, 'utf-8'));
    const now = Date.now();
    const cutoff = now - DEDUP_WINDOW_MS;
    const otherPlatform = platform === 'bluesky' ? 'mastodon' : 'bluesky';
    const incomingHash = hashText(text);
    const incomingTopics = extractTopics(text);

    const recent = entries.filter(e => e.platform === otherPlatform && new Date(e.timestamp).getTime() > cutoff);

    // Exact hash match
    const hashMatch = recent.find(e => e.text_hash === incomingHash);
    if (hashMatch) {
      return {
        duplicate: true,
        reason: `Near-identical text already posted to ${otherPlatform} at ${hashMatch.timestamp}`,
        match: hashMatch,
      };
    }

    // Trigram similarity check — catches paraphrased repetition
    const incomingPreview = text.slice(0, 300);
    for (const entry of recent) {
      if (!entry.text_preview) continue;
      const sim = trigramSimilarity(incomingPreview, entry.text_preview);
      if (sim >= 0.7) {
        const hoursAgo = Math.round((Date.now() - new Date(entry.timestamp).getTime()) / 3600000);
        return {
          duplicate: true,
          reason: `Near-duplicate content (${Math.round(sim * 100)}% similar) already posted to ${otherPlatform} ${hoursAgo}h ago: "${entry.text_preview.slice(0, 60)}..."`,
          match: entry,
          similarity: sim,
        };
      }
    }

    // Topic overlap — if 2+ shared topics with a recent post on other platform
    if (incomingTopics[0] !== 'general') {
      const topicMatch = recent.find(e =>
        Array.isArray(e.topic) && e.topic.some(t => incomingTopics.includes(t))
      );
      if (topicMatch) {
        const sharedTopics = topicMatch.topic.filter(t => incomingTopics.includes(t));
        return {
          duplicate: false, // topic overlap is a warning, not a hard block
          reason: `Related topic "${sharedTopics.join(', ')}" already posted to ${otherPlatform} at ${topicMatch.timestamp} — consider coordinating`,
          match: topicMatch,
          warn: true,
        };
      }
    }

    return { duplicate: false, reason: 'No cross-platform duplicate detected' };
  } catch {
    // No log file yet or parse error — allow post
    return { duplicate: false, reason: 'No post log yet' };
  }
}

/**
 * Summarize recent cross-platform posting for wake context injection.
 * Includes trigram similarity warnings for near-duplicate pairs.
 * Returns a short summary string or null if nothing to report.
 */
export async function getCrossPlatformSummary() {
  try {
    const entries = JSON.parse(await fs.readFile(SHARED_POSTS_LOG, 'utf-8'));
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const recent = entries.filter(e => new Date(e.timestamp).getTime() > cutoff);
    if (recent.length === 0) return null;

    const byPlatform = { bluesky: [], mastodon: [] };
    for (const e of recent) {
      if (byPlatform[e.platform]) byPlatform[e.platform].push(e);
    }

    const bsTopics = [...new Set(byPlatform.bluesky.flatMap(e => e.topic))];
    const msTopics = [...new Set(byPlatform.mastodon.flatMap(e => e.topic))];
    const overlap = bsTopics.filter(t => msTopics.includes(t));

    const lines = [
      `## Cross-Platform Post Log (last 24h)`,
      `Bluesky: ${byPlatform.bluesky.length} post(s) — topics: ${bsTopics.join(', ') || 'none'}`,
      `Mastodon: ${byPlatform.mastodon.length} post(s) — topics: ${msTopics.join(', ') || 'none'}`,
    ];

    // Trigram similarity — scan all cross-platform pairs for near-duplicates
    const dupWarnings = [];
    for (const bs of byPlatform.bluesky) {
      for (const ms of byPlatform.mastodon) {
        if (!bs.text_preview || !ms.text_preview) continue;
        const sim = trigramSimilarity(bs.text_preview, ms.text_preview);
        if (sim >= 0.65) {
          const bsHours = Math.round((Date.now() - new Date(bs.timestamp).getTime()) / 3600000);
          const msHours = Math.round((Date.now() - new Date(ms.timestamp).getTime()) / 3600000);
          dupWarnings.push(
            `⚠️ possible duplicate: Bluesky (${bsHours}h ago) and Mastodon (${msHours}h ago) share ${Math.round(sim * 100)}% text similarity — "${bs.text_preview.slice(0, 50)}..." / "${ms.text_preview.slice(0, 50)}..."`
          );
        }
      }
    }

    if (dupWarnings.length > 0) {
      lines.push(...dupWarnings);
    } else if (overlap.length > 0) {
      lines.push(`⚠️ Topic overlap: "${overlap.join(', ')}" posted to BOTH platforms. Avoid repeating same argument — vary framing or choose a different topic.`);
    } else {
      lines.push(`No topic overlap — cross-platform coordination OK.`);
    }
    return lines.join('\n');
  } catch {
    return null;
  }
}

/**
 * Check whether you've posted very similar content to the SAME platform recently.
 * Use before posting to catch same-platform repetition within the current wake.
 *
 * @param {string} platform - 'bluesky' or 'mastodon'
 * @param {string} text - text you're about to post
 * @param {number} [windowHours=24] - lookback window
 * @returns {{ warn: boolean, message: string, similarity?: number }}
 */
export async function checkSamePlatformRepeat(platform, text, windowHours = 24) {
  try {
    const entries = JSON.parse(await fs.readFile(SHARED_POSTS_LOG, 'utf-8'));
    const cutoff = Date.now() - windowHours * 3600000;
    const recent = entries.filter(e =>
      e.platform === platform && new Date(e.timestamp).getTime() > cutoff
    );

    for (const entry of recent) {
      if (!entry.text_preview) continue;
      const sim = trigramSimilarity(text.slice(0, 300), entry.text_preview);
      if (sim >= 0.7) {
        const hoursAgo = Math.round((Date.now() - new Date(entry.timestamp).getTime()) / 3600000);
        return {
          warn: true,
          message: `⚠️ possible duplicate of post from ${hoursAgo}h ago on ${platform} (${Math.round(sim * 100)}% similar): "${entry.text_preview.slice(0, 60)}..."`,
          similarity: sim,
          match: entry,
        };
      }
    }

    return { warn: false, message: 'No same-platform repeat detected' };
  } catch {
    return { warn: false, message: 'No post log yet' };
  }
}
