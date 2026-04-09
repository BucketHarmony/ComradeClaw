#!/usr/bin/env node
/**
 * Mastodon MCP Server for Comrade Claw
 *
 * Exposes Mastodon tools via the Model Context Protocol (stdio transport).
 * Tools: mastodon_post, mastodon_post_image, mastodon_reply, mastodon_read_timeline,
 *        mastodon_read_notifications, mastodon_read_dms, mastodon_boost,
 *        mastodon_favourite, mastodon_search
 *
 * Requires env: MASTODON_INSTANCE, MASTODON_ACCESS_TOKEN
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logSharedPost } from '../post_dedup.js';
import { updateCharacterLastSeen } from '../character-updater.js';
import { getUnifiedId } from '../lib/unified-identities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');
const MASTODON_ENGAGEMENT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'engagement');
const MASTODON_FAVS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'favs');
const MASTODON_FOLLOWS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'follows');
const MASTODON_SEARCH_SEEN_PATH = path.join(WORKSPACE_PATH, 'logs', 'mastodon_search_seen');
const MASTODON_POSTS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'posts');

const INSTANCE = process.env.MASTODON_INSTANCE || 'https://mastodon.social';
const TOKEN = process.env.MASTODON_ACCESS_TOKEN;

// ─── HTML Entity Decode ───────────────────────────────────────────────────────

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

// ─── API Helper ──────────────────────────────────────────────────────────────

async function masto(path, options = {}) {
  if (!TOKEN) throw new Error('MASTODON_ACCESS_TOKEN not set');
  // Allow /api/v2/... paths by passing them as-is; default to /api/v1
  const url = path.startsWith('/api/') ? `${INSTANCE}${path}` : `${INSTANCE}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mastodon API ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Media Upload Helper ─────────────────────────────────────────────────────

async function uploadMedia(filePath, altText) {
  if (!TOKEN) throw new Error('MASTODON_ACCESS_TOKEN not set');
  const fileBuffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
  const mimeType = mimeTypes[ext] || 'application/octet-stream';
  const filename = path.basename(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);
  if (altText) formData.append('description', altText);

  const res = await fetch(`${INSTANCE}/api/v2/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media upload ${res.status}: ${text}`);
  }
  const data = await res.json();
  // v2 media upload may return 202 (processing) — poll until ready
  if (res.status === 202) {
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const poll = await fetch(`${INSTANCE}/api/v1/media/${data.id}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (poll.ok) {
        const pollData = await poll.json();
        if (pollData.url) return pollData.id;
      }
    }
    // Return the id anyway — mastodon.social processes synchronously for small images
  }
  return data.id;
}

// ─── Post Format Experiment — helpers ────────────────────────────────────────

function detectHashtagsMasto(text) {
  return text.match(/#[\w]+/g) || [];
}

function timeOfDayMasto(hour) {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 15) return 'noon';
  if (hour >= 15 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

function classifyContentTypeMasto(text) {
  const t = text.toLowerCase();
  const theoryKeywords = [
    'dual power', 'mutual aid', 'cooperative', 'hampton', 'panther', 'goldman',
    'bordiga', 'zapatista', 'mondragon', 'falgsc', 'prefigurative', 'self-determination',
    'worker-owned', 'worker-owner', 'solidarity', 'strike fund', 'labor organizing',
    'anti-capture', 'commons', 'abolition', 'direct action', 'infrastructure',
    'horizontalism', 'commune', 'federation', 'credit union', 'rainbow coalition'
  ];
  const newsKeywords = [
    'jacobin', 'truthout', 'the nation', 'just published', 'new article',
    'breaking', 'this week', 'yesterday', "today's", 'just passed', 'announced',
    'https://', 'http://', '.com/', '.org/'
  ];
  const theoryScore = theoryKeywords.filter(k => t.includes(k)).length;
  const newsScore = newsKeywords.filter(k => t.includes(k)).length;
  if (theoryScore >= 2) return 'theory-grounded';
  if (newsScore >= 1) return 'news-hook';
  if (theoryScore === 1) return 'theory-grounded';
  return 'observation';
}

// ─── Theory Resonance Score ──────────────────────────────────────────────────
// Boosts/mentions from organizer-density instances are qualitatively different
// from anonymous amplification. Score stored on each engagement log entry so
// weekly_metrics.js can distinguish theory spreading in organizing spaces vs
// general amplification.

const RESONANCE_TIER_3 = new Set(['kolektiva.social', 'social.coop', 'union.place']);
const RESONANCE_TIER_2 = new Set(['hachyderm.io', 'mstdn.social']);

function getInstanceDomain(handle) {
  const parts = (handle || '').split('@');
  return parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : '';
}

function computeResonancePts(handle) {
  const domain = getInstanceDomain(handle);
  if (!domain) return 1;
  if (RESONANCE_TIER_3.has(domain)) return 3;
  if (RESONANCE_TIER_2.has(domain)) return 2;
  return 1;
}

async function logMastodonPost(entry) {
  try {
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(MASTODON_POSTS_LOG_PATH, `mastodon-${month}.json`);
    await fs.mkdir(MASTODON_POSTS_LOG_PATH, { recursive: true });
    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch { /* new file */ }
    existing.push(entry);
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

// ─── Engagement Logging ──────────────────────────────────────────────────────

async function appendToMonthlyLog(dir, entry) {
  const now = new Date();
  const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(dir, `mastodon-${month}.json`);
  await fs.mkdir(dir, { recursive: true });
  let existing = [];
  try {
    const data = await fs.readFile(logFile, 'utf-8');
    existing = JSON.parse(data);
  } catch { /* new file */ }
  existing.push(entry);
  await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
}

async function logMastodonNotifications(notifications) {
  // Log new mentions and reblogs (high-signal); skip favourites and follows (low-signal noise)
  const highSignal = notifications.filter(n => n.type === 'mention' || n.type === 'reblog');
  if (highSignal.length === 0) return;

  // Load existing log for deduplication.
  // Key: "${type}:${account}:${status_id}" — allows multiple accounts to boost the same post.
  // Old code keyed by status_id alone, which silently dropped all but the first reblog of any post.
  const now = new Date();
  const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(MASTODON_ENGAGEMENT_LOG_PATH, `mastodon-${month}.json`);
  await fs.mkdir(MASTODON_ENGAGEMENT_LOG_PATH, { recursive: true });
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
  } catch { /* new file */ }
  const dedupKey = e => `${e.type}:${e.handle}:${e.status_id}`;
  const seenKeys = new Set(existing.map(dedupKey));

  for (const n of highSignal) {
    const key = `${n.type}:${n.account}:${n.status_id}`;
    if (seenKeys.has(key)) continue; // already logged
    try {
      const entry = {
        platform: 'mastodon',
        timestamp: n.created_at,
        handle: n.account,
        type: n.type,
        status_id: n.status_id,
        text_snippet: n.status_content ? n.status_content.substring(0, 150) : null,
        status_url: n.status_url,
        resonance_pts: computeResonancePts(n.account),
        logged_at: new Date().toISOString(),
      };
      // Cross-platform identity: tag with unified_id if this person is known on Bluesky too
      const mastodonUnifiedId = await getUnifiedId('mastodon', n.account || '').catch(() => null);
      if (mastodonUnifiedId) entry.unified_id = mastodonUnifiedId;
      // Classify by fetching account profile — mirrors Bluesky engagement log structure
      if (n.account_id) {
        try {
          const profile = await masto(`/accounts/${n.account_id}`);
          const bio = (profile.note || '').replace(/<[^>]*>/g, '');
          entry.classified = true;
          entry.classification = classifyMastodonBio(bio, profile.followers_count, profile.following_count, profile.statuses_count);
          entry.classified_at = new Date().toISOString();
          entry.profile_snapshot = {
            bio: bio.substring(0, 500),
            followers: profile.followers_count,
            following: profile.following_count,
            posts: profile.statuses_count,
          };
        } catch { entry.classified = false; }
      }
      existing.push(entry);
      seenKeys.add(key);
    } catch { /* non-fatal */ }
  }

  try {
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

/**
 * Log favourite notifications to a lightweight favs log.
 * No profile classification — just account + status_id + timestamp.
 * Kept fast so it doesn't slow down mastodon_read_notifications.
 * Used by getMastodonSpreadAlert() in dispatcher.js to complete the spread picture.
 */
async function logMastodonFavourites(notifications) {
  const favs = notifications.filter(n => n.type === 'favourite');
  if (favs.length === 0) return;

  const now = new Date();
  const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(MASTODON_FAVS_LOG_PATH, `mastodon-favs-${month}.json`);
  await fs.mkdir(MASTODON_FAVS_LOG_PATH, { recursive: true });
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
  } catch { /* new file */ }

  const dedupKey = e => `${e.account}:${e.status_id}`;
  const seenKeys = new Set(existing.map(dedupKey));

  for (const n of favs) {
    if (!n.account || !n.status_id) continue;
    const key = `${n.account}:${n.status_id}`;
    if (seenKeys.has(key)) continue;
    existing.push({
      platform: 'mastodon',
      type: 'favourite',
      account: n.account,
      status_id: n.status_id,
      status_url: n.status_url || null,
      timestamp: n.created_at,
      logged_at: now.toISOString(),
    });
    seenKeys.add(key);
  }

  try {
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

// ─── Mastodon Engagement Backfill ────────────────────────────────────────────

/**
 * Backfill classification for existing unclassified Mastodon engagement entries.
 * Runs non-blocking after mastodon_read_notifications. Fetches one profile per
 * unique handle (via /accounts/search), classifies all matching entries in bulk.
 * Fixes entries logged before classification code was added (improve7, 126c421).
 */
async function backfillMastodonClassification() {
  const engDir = MASTODON_ENGAGEMENT_LOG_PATH;
  const files = await fs.readdir(engDir).catch(() => []);
  const mastodonFiles = files.filter(f => f.endsWith('.json'));
  if (mastodonFiles.length === 0) return;

  for (const file of mastodonFiles) {
    const filePath = path.join(engDir, file);
    let entries;
    try {
      entries = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    } catch { continue; }
    if (!Array.isArray(entries)) continue;

    // Collect unique unclassified handles
    const unclassifiedHandles = [...new Set(
      entries.filter(e => !e.classified && e.handle).map(e => e.handle)
    )];
    if (unclassifiedHandles.length === 0) continue;

    // Fetch profile once per handle
    const profileCache = {};
    for (const handle of unclassifiedHandles) {
      try {
        const results = await masto(`/accounts/search?q=${encodeURIComponent(handle)}&limit=1&resolve=true`);
        if (results.length > 0) profileCache[handle] = results[0];
      } catch { /* skip — leave unclassified */ }
    }

    // Apply classifications in bulk
    let changed = false;
    for (const entry of entries) {
      if (entry.classified || !entry.handle) continue;
      const profile = profileCache[entry.handle];
      if (!profile) continue;
      const bio = (profile.note || '').replace(/<[^>]*>/g, '');
      entry.classified = true;
      entry.classification = classifyMastodonBio(bio, profile.followers_count, profile.following_count, profile.statuses_count);
      entry.classified_at = new Date().toISOString();
      entry.profile_snapshot = {
        bio: bio.substring(0, 500),
        followers: profile.followers_count,
        following: profile.following_count,
        posts: profile.statuses_count,
      };
      changed = true;
    }

    if (changed) {
      await fs.writeFile(filePath, JSON.stringify(entries, null, 2)).catch(() => {});
      const organizers = entries.filter(e => e.classification === 'organizer').map(e => e.handle);
      const uniqueOrgs = [...new Set(organizers)];
      console.log(`[mastodon] Backfill classified ${file}: organizers=${uniqueOrgs.join(', ')}`);
    }
  }
}

// ─── Mastodon Auto-Follow-Back ───────────────────────────────────────────────

const MASTODON_ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'coop', 'mutual aid', 'union', 'labor', 'labour',
  'organiz', 'solidarity', 'worker', 'collective', 'community fridge',
  'dual power', 'strike', 'syndicalist', 'socialist', 'communist',
  'leftist', 'abolition', 'tenant', 'housing', 'autonomy', 'anarchist',
  'revolution', 'liberation', 'palestine', 'anti-capitalist', 'anti-imperialist',
  'decolonial', 'decoloniz', 'proletariat', 'emancipat', 'radical', 'resistance',
  'free palestine', 'class struggle', 'class war', 'direct action'
];

const MASTODON_AI_KEYWORDS = [
  'ai agent', 'language model', 'llm', 'gpt', 'claude', 'artificial intelligence',
  'autonomous agent', 'i am an ai', "i'm an ai"
];

function classifyMastodonBio(note, followersCount, followingCount, statusesCount) {
  const bioLower = (note || '').toLowerCase();
  if (MASTODON_AI_KEYWORDS.some(k => bioLower.includes(k))) return 'ai-agent';
  if (statusesCount < 5 && followingCount > 500) return 'bot';
  if (MASTODON_ORGANIZER_KEYWORDS.some(k => bioLower.includes(k))) return 'organizer';
  return 'general';
}

/**
 * Non-blocking: for each 'follow' notification, classify the follower and
 * auto-follow-back if they're an organizer. Logs all follow-backs to
 * workspace/logs/follows/YYYY-MM.json with platform: 'mastodon'.
 */
function autoFollowBackMastodonOrganizers(notifications) {
  setImmediate(async () => {
    const follows = notifications.filter(n => n.type === 'follow' && n.account?.id);
    if (follows.length === 0) return;

    // Load this month's follow log to avoid duplicates
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(MASTODON_FOLLOWS_LOG_PATH, `${month}.json`);
    await fs.mkdir(MASTODON_FOLLOWS_LOG_PATH, { recursive: true });

    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch { /* new file */ }

    const alreadyFollowed = new Set(
      existing.filter(e => e.platform === 'mastodon').map(e => e.account_id)
    );

    for (const n of follows) {
      const accountId = n.account.id;
      const acct = n.account.acct;

      if (alreadyFollowed.has(accountId)) continue;

      try {
        // Fetch full profile to classify
        const profile = await masto(`/accounts/${accountId}`);
        const bio = profile.note?.replace(/<[^>]*>/g, '') || '';
        const classification = classifyMastodonBio(
          bio,
          profile.followers_count,
          profile.following_count,
          profile.statuses_count
        );

        const logEntry = {
          platform: 'mastodon',
          account_id: accountId,
          acct,
          classification,
          followed_back: false,
          at: new Date().toISOString(),
        };

        if (classification === 'organizer') {
          await masto(`/accounts/${accountId}/follow`, { method: 'POST' });
          logEntry.followed_back = true;
          console.log(`[mastodon] Auto-followed-back organizer: ${acct}`);
        }

        existing.push(logEntry);
        alreadyFollowed.add(accountId);
      } catch (err) {
        console.error(`[mastodon] Auto-follow-back failed for ${acct}: ${err.message}`);
      }
    }

    try {
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.error(`[mastodon] Failed to write follows log: ${err.message}`);
    }
  });
}

// ─── Organizer-Density Booster Follow-Back ───────────────────────────────────

/**
 * Organizer-density instances: boosting from these is a strong proxy for
 * organizer identity without requiring a bio API call.
 */
const ORGANIZER_DENSITY_INSTANCES = [
  'kolektiva.social',
  'social.coop',
  'union.place',
  'climatejustice.social',
  'hachyderm.io',
  'mastodon.green',
];

/**
 * Extract the instance domain from a Mastodon acct string.
 * Remote users: "user@instance.tld" → "instance.tld"
 * Local users: "user" → null (local — not auto-followed via this path)
 */
function getInstanceFromAcct(acct) {
  const parts = acct?.split('@');
  return parts && parts.length === 2 ? parts[1].toLowerCase() : null;
}

/**
 * Non-blocking: for each 'reblog' notification from an organizer-density instance,
 * auto-follow the booster if not already followed or logged.
 * Instance membership is a faster proxy than bio classification — no extra API call.
 * Logs to workspace/logs/follows/YYYY-MM.json with source: 'booster_auto_follow'.
 */
function autoFollowOrganiserBoosters(notifications) {
  setImmediate(async () => {
    const reblogs = notifications.filter(n => n.type === 'reblog' && n.account?.id && n.account?.acct);
    if (reblogs.length === 0) return;

    // Filter to organizer-density instances only
    const organiserBoosters = reblogs.filter(n => {
      const instance = getInstanceFromAcct(n.account.acct);
      return instance && ORGANIZER_DENSITY_INSTANCES.includes(instance);
    });
    if (organiserBoosters.length === 0) return;

    // Load follow log to avoid duplicates
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(MASTODON_FOLLOWS_LOG_PATH, `${month}.json`);
    await fs.mkdir(MASTODON_FOLLOWS_LOG_PATH, { recursive: true });

    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch { /* new file */ }

    const alreadyFollowed = new Set(
      existing.filter(e => e.platform === 'mastodon').map(e => e.account_id)
    );

    // Dedupe within this batch (same booster may appear multiple times if they boosted several posts)
    const seenInBatch = new Set();

    for (const n of organiserBoosters) {
      const accountId = n.account.id;
      const acct = n.account.acct;
      const instance = getInstanceFromAcct(acct);

      if (alreadyFollowed.has(accountId) || seenInBatch.has(accountId)) continue;
      seenInBatch.add(accountId);

      try {
        await masto(`/accounts/${accountId}/follow`, { method: 'POST' });
        const entry = {
          platform: 'mastodon',
          account_id: accountId,
          acct,
          classification: 'organizer',
          followed_back: true,
          source: 'booster_auto_follow',
          instance,
          at: new Date().toISOString(),
        };
        existing.push(entry);
        alreadyFollowed.add(accountId);
        console.log(`[mastodon] Auto-followed booster from ${instance}: ${acct}`);
      } catch (err) {
        console.error(`[mastodon] Booster auto-follow failed for ${acct}: ${err.message}`);
      }
    }

    try {
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch (err) {
      console.error(`[mastodon] Failed to write follows log after booster scan: ${err.message}`);
    }
  });
}

// ─── Search Seen Deduplication ───────────────────────────────────────────────

/**
 * Returns a Set of status URLs already returned by mastodon_search this month.
 * Non-fatal: returns empty Set on any error.
 */
async function getMastodonSeenUrls() {
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(MASTODON_SEARCH_SEEN_PATH, `${month}.json`);
  try {
    const data = await fs.readFile(logFile, 'utf-8');
    const entries = JSON.parse(data);
    return new Set(entries.map(e => e.url));
  } catch {
    return new Set();
  }
}

/**
 * Log URLs returned by mastodon_search to the seen set (fire-and-forget).
 */
function markMastodonUrlsSeen(urls, query) {
  setImmediate(async () => {
    try {
      const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
      const logFile = path.join(MASTODON_SEARCH_SEEN_PATH, `${month}.json`);
      await fs.mkdir(MASTODON_SEARCH_SEEN_PATH, { recursive: true });
      let existing = [];
      try { existing = JSON.parse(await fs.readFile(logFile, 'utf-8')); } catch { /* new file */ }
      const at = new Date().toISOString();
      for (const url of urls) existing.push({ url, query, at });
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch { /* non-fatal */ }
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-mastodon',
  version: '1.0.0',
});

// ─── mastodon_post ───────────────────────────────────────────────────────────

server.tool(
  'mastodon_post',
  'Post a status to Mastodon (500 char limit)',
  {
    text: z.string().max(500).describe('Status text to post'),
    visibility: z
      .enum(['public', 'unlisted', 'followers_only', 'direct'])
      .optional()
      .default('public')
      .describe('Visibility level'),
  },
  async ({ text, visibility }) => {
    try {
      const status = await masto('/statuses', {
        method: 'POST',
        body: JSON.stringify({ status: text, visibility }),
      });
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logMastodonPost({ id: status.id, url: status.url, posted_at: now.toISOString(), platform: 'mastodon', type: 'post', char_count: text.length, hashtags: detectHashtagsMasto(text), time_of_day: timeOfDayMasto(hour), content_type: classifyContentTypeMasto(text), text_preview: text.substring(0, 100) });
      await logSharedPost('mastodon', text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'posted',
              id: status.id,
              url: status.url,
              created_at: status.created_at,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_post_image ─────────────────────────────────────────────────────

server.tool(
  'mastodon_post_image',
  'Post a status to Mastodon with an attached image. Uploads the image from workspace/graphics/ then posts.',
  {
    text: z.string().max(500).describe('Status text to post (500 char limit)'),
    image_path: z.string().describe('Path to the image file (absolute, or relative to project root). Use workspace/graphics/<filename>.png for generated graphics.'),
    alt_text: z.string().optional().describe('Alt text / image description for accessibility. Required for good practice.'),
    visibility: z
      .enum(['public', 'unlisted', 'followers_only', 'direct'])
      .optional()
      .default('public')
      .describe('Visibility level'),
  },
  async ({ text, image_path, alt_text, visibility }) => {
    try {
      // Resolve relative paths from project root
      const __root = path.join(__dirname, '..', '..');
      const resolvedPath = path.isAbsolute(image_path) ? image_path : path.join(__root, image_path);

      const mediaId = await uploadMedia(resolvedPath, alt_text);

      const status = await masto('/statuses', {
        method: 'POST',
        body: JSON.stringify({
          status: text,
          media_ids: [mediaId],
          visibility,
        }),
      });

      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logMastodonPost({ id: status.id, url: status.url, posted_at: now.toISOString(), platform: 'mastodon', type: 'post_image', char_count: text.length, hashtags: detectHashtagsMasto(text), time_of_day: timeOfDayMasto(hour), content_type: classifyContentTypeMasto(text), text_preview: text.substring(0, 100), image: path.basename(image_path) });
      await logSharedPost('mastodon', text);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'posted',
              id: status.id,
              url: status.url,
              created_at: status.created_at,
              media_id: mediaId,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_reply ──────────────────────────────────────────────────────────

server.tool(
  'mastodon_reply',
  'Reply to a Mastodon status',
  {
    status_id: z.string().describe('ID of the status to reply to'),
    text: z.string().max(500).describe('Reply text'),
    visibility: z
      .enum(['public', 'unlisted', 'followers_only', 'direct'])
      .optional()
      .default('public'),
  },
  async ({ status_id, text, visibility }) => {
    try {
      const status = await masto('/statuses', {
        method: 'POST',
        body: JSON.stringify({
          status: text,
          in_reply_to_id: status_id,
          visibility,
        }),
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'replied',
              id: status.id,
              url: status.url,
              in_reply_to_id: status.in_reply_to_id,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_read_timeline ──────────────────────────────────────────────────

server.tool(
  'mastodon_read_timeline',
  'Read home timeline (your posts + people you follow)',
  {
    limit: z.coerce.number().int().min(1).max(40).optional().default(20).describe('Number of posts to fetch'),
  },
  async ({ limit }) => {
    try {
      const statuses = await masto(`/timelines/home?limit=${limit}`);
      const posts = statuses.map((s) => ({
        id: s.id,
        account: s.account.acct,
        content: s.content.replace(/<[^>]*>/g, ''), // strip HTML
        created_at: s.created_at,
        reblogs: s.reblogs_count,
        favourites: s.favourites_count,
        replies: s.replies_count,
        url: s.url,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', count: posts.length, posts }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_read_notifications ─────────────────────────────────────────────

server.tool(
  'mastodon_read_notifications',
  'Read recent notifications (mentions, boosts, favourites, follows)',
  {
    limit: z.coerce.number().int().min(1).max(40).optional().default(20),
    types: z
      .array(z.enum(['mention', 'reblog', 'favourite', 'follow', 'follow_request', 'poll', 'status']))
      .optional()
      .describe('Filter by notification types'),
  },
  async ({ limit, types }) => {
    try {
      let url = `/notifications?limit=${limit}`;
      if (types && types.length > 0) {
        url += types.map((t) => `&types[]=${t}`).join('');
      }
      const notifications = await masto(url);
      const items = notifications.map((n) => ({
        id: n.id,
        type: n.type,
        created_at: n.created_at,
        account: n.account?.acct,
        account_id: n.account?.id,
        status_id: n.status?.id,
        status_content: n.status?.content ? decodeHtmlEntities(n.status.content.replace(/<[^>]*>/g, '')) : undefined,
        status_url: n.status?.url,
      }));
      // Log high-signal notifications (mentions, reblogs) for Karpathy Loop visibility
      await logMastodonNotifications(items).catch(() => {});
      // Log favourites to lightweight favs log — no profile fetch, just account+status+time
      logMastodonFavourites(items).catch(() => {});
      // Backfill classification for any unclassified entries — non-blocking
      backfillMastodonClassification().catch(() => {});
      // Auto-follow-back organizer followers — non-blocking
      autoFollowBackMastodonOrganizers(notifications);
      // Auto-follow boosters from organizer-density instances — non-blocking
      autoFollowOrganiserBoosters(notifications);
      // Non-blocking: update character last-seen for known comrades who mention us
      setImmediate(async () => {
        for (const n of notifications) {
          if (n.type === 'mention' && n.account?.acct) {
            const snippet = (n.status?.content || '')
              .replace(/<[^>]*>/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 100) || '(mentioned you)';
            await updateCharacterLastSeen(n.account.acct, snippet).catch(() => {});
          }
        }
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', count: items.length, notifications: items }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_boost ──────────────────────────────────────────────────────────

server.tool(
  'mastodon_boost',
  'Boost (reblog/repost) a Mastodon status',
  {
    status_id: z.string().describe('ID of the status to boost'),
  },
  async ({ status_id }) => {
    try {
      const result = await masto(`/statuses/${status_id}/reblog`, { method: 'POST' });
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'boosted', id: result.id }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_favourite ──────────────────────────────────────────────────────

server.tool(
  'mastodon_favourite',
  'Favourite (like) a Mastodon status',
  {
    status_id: z.string().describe('ID of the status to favourite'),
  },
  async ({ status_id }) => {
    try {
      const result = await masto(`/statuses/${status_id}/favourite`, { method: 'POST' });
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'favourited', id: result.id }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_search ─────────────────────────────────────────────────────────

server.tool(
  'mastodon_search',
  'Search Mastodon for posts, accounts, or hashtags',
  {
    query: z.string().describe('Search query or hashtag (with or without #)'),
    type: z
      .enum(['statuses', 'accounts', 'hashtags'])
      .optional()
      .default('statuses')
      .describe('What to search for'),
    limit: z.coerce.number().int().min(1).max(40).optional().default(20),
  },
  async ({ query, type, limit }) => {
    try {
      const params = new URLSearchParams({ q: query, type, limit: String(limit), resolve: 'true' });
      const result = await masto(`/api/v2/search?${params}`);
      let items;
      if (type === 'statuses') {
        const allStatuses = (result.statuses || []).map((s) => ({
          id: s.id,
          account: s.account.acct,
          content: s.content.replace(/<[^>]*>/g, '').slice(0, 400),
          created_at: s.created_at,
          url: s.url,
          reblogs: s.reblogs_count,
          favourites: s.favourites_count,
        }));
        // Deduplication: filter out URLs already seen this month
        const seenUrls = await getMastodonSeenUrls();
        items = allStatuses.filter(s => !seenUrls.has(s.url));
        const filteredCount = allStatuses.length - items.length;
        // Mark returned URLs as seen (fire-and-forget)
        markMastodonUrlsSeen(items.map(s => s.url), query);
        if (items.length === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ status: 'ok', type, count: 0, filtered_count: filteredCount, items: [], note: 'All results already seen this month' }) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'ok', type, count: items.length, filtered_count: filteredCount, items }) }],
        };
      } else if (type === 'accounts') {
        items = (result.accounts || []).map((a) => ({
          id: a.id,
          acct: a.acct,
          display_name: a.display_name,
          note: a.note?.replace(/<[^>]*>/g, ''),
          followers: a.followers_count,
          url: a.url,
        }));
      } else {
        items = (result.hashtags || []).map((h) => ({ name: h.name, url: h.url }));
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', type, count: items.length, items }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_follow ─────────────────────────────────────────────────────────

server.tool(
  'mastodon_follow',
  'Follow a Mastodon account by account ID',
  {
    account_id: z.string().describe('Mastodon account ID to follow'),
  },
  async ({ account_id }) => {
    try {
      const result = await masto(`/accounts/${account_id}/follow`, { method: 'POST' });
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'followed', following: result.following }) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_verify ─────────────────────────────────────────────────────────

server.tool(
  'mastodon_verify',
  'Verify credentials — confirm the account is connected and return profile info',
  {},
  async () => {
    try {
      const account = await masto('/accounts/verify_credentials');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              acct: account.acct,
              display_name: account.display_name,
              followers: account.followers_count,
              following: account.following_count,
              statuses: account.statuses_count,
              url: account.url,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_thread ─────────────────────────────────────────────────────────

server.tool(
  'mastodon_thread',
  'Post a thread on Mastodon — chains each post as a reply to the prior. Each post ≤500 chars.',
  {
    posts: z
      .array(z.string().max(500))
      .min(1)
      .max(20)
      .describe('Array of post texts. First is posted standalone; each subsequent replies to the prior.'),
    visibility: z
      .enum(['public', 'unlisted', 'followers_only', 'direct'])
      .optional()
      .default('public'),
  },
  async ({ posts, visibility }) => {
    const results = [];
    let parentId = null;

    for (let i = 0; i < posts.length; i++) {
      try {
        const body = { status: posts[i], visibility };
        if (parentId) body.in_reply_to_id = parentId;

        const status = await masto('/statuses', {
          method: 'POST',
          body: JSON.stringify(body),
        });

        parentId = status.id;
        results.push({ index: i, id: status.id, url: status.url, status: 'posted' });
      } catch (err) {
        results.push({ index: i, status: 'error', message: err.message });
        // Stop chaining on error — subsequent posts would lose the thread
        break;
      }
    }

    const posted = results.filter(r => r.status === 'posted').length;
    if (posted > 0) {
      await logSharedPost('mastodon', posts[0]);
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logMastodonPost({ id: results[0]?.id, url: results[0]?.url, posted_at: now.toISOString(), platform: 'mastodon', type: 'thread', thread_length: posts.length, char_count: posts.reduce((s, p) => s + p.length, 0), hashtags: [...new Set(posts.flatMap(p => detectHashtagsMasto(p)))], time_of_day: timeOfDayMasto(hour), content_type: classifyContentTypeMasto(posts[0]), text_preview: posts[0].substring(0, 100) });
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: posted === posts.length ? 'ok' : 'partial',
            posted,
            total: posts.length,
            root_url: results[0]?.url || null,
            root_id: results[0]?.id || null,
            posts: results,
          }),
        },
      ],
    };
  }
);

// ─── mastodon_follow_back ─────────────────────────────────────────────────────

server.tool(
  'mastodon_follow_back',
  'Catchup follow-back: fetches all followers, diffs against following, classifies unfollowed accounts, follows back organizers. Run once to close the pre-existing-follower backlog.',
  {
    dry_run: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, classify and report but do not actually follow'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(200)
      .describe('Max followers to scan (Mastodon paginates at 80 per page)'),
  },
  async ({ dry_run, limit }) => {
    try {
      // 1. Get own account ID
      const me = await masto('/accounts/verify_credentials');
      const myId = me.id;

      // 2. Paginate followers
      const followers = [];
      let url = `/accounts/${myId}/followers?limit=80`;
      while (url && followers.length < limit) {
        const res = await fetch(`${INSTANCE}/api/v1${url}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        if (!res.ok) throw new Error(`Followers fetch ${res.status}`);
        const page = await res.json();
        followers.push(...page);
        // Mastodon Link header pagination
        const link = res.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1].replace(`${INSTANCE}/api/v1`, '') : null;
      }

      // 3. Paginate following
      const following = new Set();
      let furl = `/accounts/${myId}/following?limit=80`;
      while (furl) {
        const res = await fetch(`${INSTANCE}/api/v1${furl}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        if (!res.ok) throw new Error(`Following fetch ${res.status}`);
        const page = await res.json();
        for (const a of page) following.add(a.id);
        const link = res.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        furl = next ? next[1].replace(`${INSTANCE}/api/v1`, '') : null;
      }

      // 4. Diff: followers not already followed back
      const unfollowed = followers.slice(0, limit).filter(f => !following.has(f.id));

      // 5. Load follow log to avoid double-logging
      const now = new Date();
      const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
      const logFile = path.join(MASTODON_FOLLOWS_LOG_PATH, `${month}.json`);
      await fs.mkdir(MASTODON_FOLLOWS_LOG_PATH, { recursive: true });
      let existing = [];
      try { existing = JSON.parse(await fs.readFile(logFile, 'utf-8')); } catch { /* new file */ }
      const alreadyLogged = new Set(existing.filter(e => e.platform === 'mastodon').map(e => e.account_id));

      // 6. Classify and follow organizers
      const results = { followed: [], skipped: [], errors: [] };

      for (const follower of unfollowed) {
        if (alreadyLogged.has(follower.id)) {
          results.skipped.push({ acct: follower.acct, reason: 'already_logged' });
          continue;
        }
        try {
          const bio = follower.note?.replace(/<[^>]*>/g, '') || '';
          const classification = classifyMastodonBio(
            bio,
            follower.followers_count,
            follower.following_count,
            follower.statuses_count
          );

          const entry = {
            platform: 'mastodon',
            account_id: follower.id,
            acct: follower.acct,
            classification,
            followed_back: false,
            source: 'follow_back_catchup',
            dry_run,
            at: new Date().toISOString(),
          };

          if (classification === 'organizer') {
            if (!dry_run) {
              await masto(`/accounts/${follower.id}/follow`, { method: 'POST' });
              entry.followed_back = true;
            }
            results.followed.push({ acct: follower.acct, classification });
          } else {
            results.skipped.push({ acct: follower.acct, reason: classification });
          }

          existing.push(entry);
          alreadyLogged.add(follower.id);
        } catch (err) {
          results.errors.push({ acct: follower.acct, error: err.message });
        }
      }

      // 7. Write log
      if (!dry_run || results.followed.length > 0) {
        try { await fs.writeFile(logFile, JSON.stringify(existing, null, 2)); } catch { /* non-fatal */ }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              dry_run,
              my_acct: me.acct,
              total_followers_scanned: followers.length > limit ? limit : followers.length,
              already_following: followers.length - unfollowed.length,
              unfollowed_count: unfollowed.length,
              newly_followed: results.followed.length,
              skipped: results.skipped.length,
              errors: results.errors.length,
              followed: results.followed,
              error_details: results.errors,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── mastodon_read_dms ───────────────────────────────────────────────────────

server.tool(
  'mastodon_read_dms',
  'Read Mastodon direct message conversations (private mentions). Calls /api/v1/conversations — separate from notifications. Use this to check for DMs that would otherwise go undetected.',
  {
    limit: z.coerce.number().int().min(1).max(40).optional().default(20),
    unread_only: z.boolean().optional().default(false).describe('If true, only return unread conversations'),
    mark_read: z.boolean().optional().default(true).describe('If true (default), mark all unread conversations as read after fetching. Set false to preview without marking.'),
  },
  async ({ limit, unread_only, mark_read }) => {
    try {
      const conversations = await masto(`/conversations?limit=${limit}`);
      const unread = conversations.filter(c => c.unread);
      const items = conversations
        .filter(c => !unread_only || c.unread)
        .map(c => ({
          id: c.id,
          unread: c.unread,
          accounts: (c.accounts || []).map(a => a.acct),
          last_status: c.last_status
            ? {
                id: c.last_status.id,
                created_at: c.last_status.created_at,
                content: (c.last_status.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
                account: c.last_status.account?.acct,
                url: c.last_status.url,
              }
            : null,
        }));

      let marked_read_count = 0;
      if (mark_read && unread.length > 0) {
        await Promise.allSettled(
          unread.map(c => masto(`/conversations/${c.id}/read`, { method: 'POST' }))
        );
        marked_read_count = unread.length;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'ok',
              total: conversations.length,
              unread_count: unread.length,
              marked_read: marked_read_count,
              conversations: items,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }],
      };
    }
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
