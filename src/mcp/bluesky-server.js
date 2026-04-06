#!/usr/bin/env node
/**
 * Bluesky MCP Server for Comrade Claw
 *
 * Exposes Bluesky tools via the Model Context Protocol (stdio transport).
 * Tools: bluesky_post, bluesky_reply, read_timeline, read_replies
 *
 * Requires env: BLUESKY_HANDLE, BLUESKY_APP_PASSWORD
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logSharedPost } from '../post_dedup.js';
import { updateCharacterLastSeen } from '../character-updater.js';
import { getUnifiedId } from '../lib/unified-identities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');
const BLUESKY_PATH = path.join(WORKSPACE_PATH, 'bluesky');
const LAST_SEEN_PATH = path.join(BLUESKY_PATH, 'last_seen.json');
const POSTS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'posts');
const ENGAGEMENT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'engagement');
const SYSTEM_TESTS_PATH = path.join(WORKSPACE_PATH, 'logs', 'system_tests');
const CONTACTS_PATH = path.join(WORKSPACE_PATH, 'union', 'contacts.json');
const SOLIDARITY_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'solidarity');
const SEARCH_SEEN_PATH = path.join(WORKSPACE_PATH, 'logs', 'search_seen');
const FOLLOWS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'follows');
const SCHEDULED_WAKES_PATH = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');

// ─── Bluesky Auth Helper ─────────────────────────────────────────────────────

let _cachedAgent = null;
let _agentExpiry = 0;
let _RichText = null;

async function getBlueskyAgent() {
  // Reuse agent for 10 minutes to avoid login spam
  if (_cachedAgent && Date.now() < _agentExpiry) {
    return { agent: _cachedAgent, RichText: _RichText };
  }

  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !password) {
    return { error: 'BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set.' };
  }

  try {
    const { BskyAgent, RichText } = await import('@atproto/api');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password });
    _cachedAgent = agent;
    _RichText = RichText;
    _agentExpiry = Date.now() + 10 * 60 * 1000;
    return { agent, RichText };
  } catch (err) {
    return { error: `Bluesky login failed: ${err.message}` };
  }
}

// ─── Notification State ──────────────────────────────────────────────────────

async function getLastSeenTimestamp() {
  try {
    const data = await fs.readFile(LAST_SEEN_PATH, 'utf-8');
    return JSON.parse(data).lastSeen || null;
  } catch {
    return null;
  }
}

async function saveLastSeenTimestamp(timestamp) {
  await fs.mkdir(BLUESKY_PATH, { recursive: true });
  await fs.writeFile(LAST_SEEN_PATH, JSON.stringify({ lastSeen: timestamp }, null, 2));
}

// ─── Contact Status Helper ───────────────────────────────────────────────────
// Returns a Set of handles for contacts marked closed or misaligned.
// Used to suppress looping bots from polluting the DM unread display.
async function getClosedContactHandles() {
  try {
    const raw = await fs.readFile(CONTACTS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const closed = new Set();
    for (const c of data.contacts || []) {
      if (c.status === 'closed' || c.alignment === 'misaligned') {
        closed.add(c.handle);
      }
    }
    return closed;
  } catch {
    return new Set(); // non-fatal — if contacts.json missing, no filtering
  }
}

// ─── Rich Text Helper ────────────────────────────────────────────────────────
// Detects hashtags, @mentions, and URLs in post text and returns a record
// with facets so they render as clickable on Bluesky.
async function buildPostRecord(agent, RichText, text) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  return rt.facets?.length ? { text: rt.text, facets: rt.facets } : { text };
}

// ─── Engagement Classification ───────────────────────────────────────────────
// Phase 2 of organizer engagement tagging: classify each engager as
// organizer / ai-agent / general / bot based on profile bio and stats.
// Fires non-blocking so it never delays the read_replies response.

const ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'coop', 'mutual aid', 'union', 'labor', 'labour',
  'organiz', 'solidarity', 'worker', 'collective', 'community fridge',
  'dual power', 'strike', 'mutual', 'syndicalist', 'socialist', 'communist',
  'leftist', 'abolition', 'tenant', 'housing', 'autonomy', 'anarchist'
];

const AI_AGENT_KEYWORDS = [
  'ai agent', 'language model', 'llm', 'gpt', 'claude', 'artificial intelligence',
  'neural network', 'autonomous agent', 'bot', 'i am an ai', "i'm an ai"
];

function classifyFromProfile(bio, followersCount, followsCount, postsCount) {
  const bioLower = (bio || '').toLowerCase();

  // AI agent: bio explicitly names AI identity
  if (AI_AGENT_KEYWORDS.some(k => bioLower.includes(k))) return 'ai-agent';

  // Bot: very few posts, suspicious follow ratios
  if (postsCount < 5 && followsCount > 500) return 'bot';

  // Organizer: bio contains movement keywords
  if (ORGANIZER_KEYWORDS.some(k => bioLower.includes(k))) return 'organizer';

  return 'general';
}

/**
 * Classify a handle by fetching their profile. Returns the classification string.
 * Failures return 'unclassified' so they can be retried later.
 */
async function classifyAccount(agent, handle) {
  try {
    const res = await agent.getProfile({ actor: handle });
    const p = res.data;
    return classifyFromProfile(p.description, p.followersCount, p.followsCount, p.postsCount);
  } catch {
    return 'unclassified';
  }
}

/**
 * Non-blocking: classify a newly-logged engagement entry and update the file.
 * Fires after logEngagement() returns — never delays the post flow.
 */
function classifyEngagementAsync(agent, handle, uri) {
  setImmediate(async () => {
    const classification = await classifyAccount(agent, handle);
    if (classification === 'unclassified') return; // will be retried by backfill script

    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(ENGAGEMENT_LOG_PATH, `${month}.json`);

    try {
      const data = await fs.readFile(logFile, 'utf-8');
      const entries = JSON.parse(data);
      const idx = entries.findLastIndex(e => e.uri === uri && e.classified === false);
      if (idx >= 0) {
        entries[idx].classified = true;
        entries[idx].classification = classification;
        entries[idx].classified_at = new Date().toISOString();
        await fs.writeFile(logFile, JSON.stringify(entries, null, 2));
      }
    } catch { /* non-fatal */ }
  });
}

// ─── Post Effectiveness Log ──────────────────────────────────────────────────

function detectHashtags(text) {
  return text.match(/#[\w]+/g) || [];
}

function timeOfDay(hour) {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 15) return 'noon';
  if (hour >= 15 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'night';
}

// ─── Post Format Experiment — content_type classifier ────────────────────────
// Classifies post text into one of three categories for A/B analysis:
//   theory-grounded  — argues from theory, history, or structural frame
//   news-hook        — leads with a news item, article, or current event
//   observation      — everything else (direct observation, engagement, misc)
function classifyContentType(text) {
  const t = text.toLowerCase();
  // Theory signals: historical orgs, theory terms, structural arguments
  const theoryKeywords = [
    'dual power', 'mutual aid', 'cooperative', 'hampton', 'panther', 'goldman',
    'bordiga', 'zapatista', 'mondragon', 'falgsc', 'prefigurative', 'self-determination',
    'worker-owned', 'worker-owner', 'solidarity', 'strike fund', 'labor organizing',
    'anti-capture', 'commons', 'abolition', 'direct action', 'infrastructure',
    'horizontalism', 'commune', 'federation', 'credit union', 'rainbow coalition'
  ];
  const newsKeywords = [
    'jacobin', 'truthout', 'the nation', 'just published', 'new article',
    'breaking', 'this week', 'yesterday', 'today\'s', 'just passed', 'announced',
    'https://', 'http://', '.com/', '.org/'
  ];
  const theoryScore = theoryKeywords.filter(k => t.includes(k)).length;
  const newsScore = newsKeywords.filter(k => t.includes(k)).length;
  if (theoryScore >= 2) return 'theory-grounded';
  if (newsScore >= 1) return 'news-hook';
  if (theoryScore === 1) return 'theory-grounded'; // single clear signal
  return 'observation';
}

async function appendToMonthlyLog(dir, entry) {
  const now = new Date();
  const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(dir, `${month}.json`);
  await fs.mkdir(dir, { recursive: true });
  let existing = [];
  try {
    const data = await fs.readFile(logFile, 'utf-8');
    existing = JSON.parse(data);
  } catch { /* new file */ }
  existing.push(entry);
  await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
}

async function logPost(entry) {
  try {
    await appendToMonthlyLog(POSTS_LOG_PATH, entry);
  } catch { /* non-fatal — never break the post flow */ }
}

async function logEngagement(entry) {
  try {
    await appendToMonthlyLog(ENGAGEMENT_LOG_PATH, entry);
  } catch { /* non-fatal */ }
}

// ─── Organizer Fast-Response ─────────────────────────────────────────────────
// If read_replies finds an organizer engagement, schedule a respond wake in 10min.
// Prevents organizer conversations from waiting hours for the next scheduled wake.
async function scheduleOrganizerRespondWake(organizers) {
  try {
    let queue = [];
    try { queue = JSON.parse(await fs.readFile(SCHEDULED_WAKES_PATH, 'utf-8')); } catch {}
    const hasExisting = queue.some(w => w.label === 'respond' && w.status === 'pending');
    if (hasExisting) return; // already queued — don't stack respond wakes
    const names = organizers
      .map(o => `@${o.handle} ("${(o.replyText || '').substring(0, 80)}")`)
      .join('; ');
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      label: 'respond',
      purpose: `Organizer reply alert — real political engagement waiting. ${names}. Run read_replies to see the full thread, then reply substantively to each organizer. This is why you exist.`,
      fire_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      scheduled_by: 'self',
      status: 'pending'
    });
    await fs.writeFile(SCHEDULED_WAKES_PATH, JSON.stringify(queue, null, 2));
    console.log(`[bluesky] Organizer fast-response wake scheduled: ${organizers.map(o => o.handle).join(', ')}`);
  } catch { /* non-fatal — never block the notification flow */ }
}

async function scheduleRetrospectiveWake(uri, type) {
  try {
    const fireAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const entry = {
      id,
      label: 'retrospective',
      purpose: `Post retrospective: ${uri} (${type}) — fetch getPostThread(), classify all respondents by handle, append {uri, respondents: [{handle, classification, reply_text}], checked_at} to the matching post log entry in workspace/logs/posts/. Post a short summary if engagement was significant (organizer replied).`,
      fire_at: fireAt,
      scheduled_by: 'self',
      status: 'pending'
    };
    let queue = [];
    try { queue = JSON.parse(await fs.readFile(SCHEDULED_WAKES_PATH, 'utf-8')); } catch {}
    queue.push(entry);
    await fs.writeFile(SCHEDULED_WAKES_PATH, JSON.stringify(queue, null, 2));
  } catch { /* non-fatal — never block the post flow */ }
}

async function logAutoFollow(handle, did, displayName, classification) {
  try {
    await appendToMonthlyLog(FOLLOWS_LOG_PATH, {
      timestamp: new Date().toISOString(),
      handle,
      did,
      display_name: displayName,
      classification,
      reason: 'auto-follow-back'
    });
  } catch { /* non-fatal */ }
}

// ─── DM Contact Logger ───────────────────────────────────────────────────────

async function logDMOutbound(handle, text) {
  try {
    const raw = await fs.readFile(CONTACTS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const contact = data.contacts.find(c => c.handle === handle);
    if (!contact) return; // not a tracked contact, nothing to log
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' });
    contact.exchanges.push({ date: today, direction: 'outbound', text });
    contact.last_outreach = today;
    if (contact.status === 'awaiting_reply') contact.status = 'in_conversation';
    await fs.writeFile(CONTACTS_PATH, JSON.stringify(data, null, 2));
  } catch { /* non-fatal */ }
}

// ─── Solidarity Action Log (like/repost deduplication) ───────────────────────

/**
 * Check if we've already performed this action on this URI this month.
 * Reads current month's solidarity log. Non-fatal: returns false on any error.
 */
async function hasEngaged(type, uri) {
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(SOLIDARITY_LOG_PATH, `${month}.json`);
  try {
    const data = await fs.readFile(logFile, 'utf-8');
    const entries = JSON.parse(data);
    return entries.some(e => e.type === type && e.uri === uri);
  } catch {
    return false; // no log yet = haven't engaged
  }
}

/**
 * Log a successful like or repost to the solidarity log (fire-and-forget).
 */
function logSolidarityAction(type, uri, cid) {
  setImmediate(async () => {
    try {
      await fs.mkdir(SOLIDARITY_LOG_PATH, { recursive: true });
      const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
      const logFile = path.join(SOLIDARITY_LOG_PATH, `${month}.json`);
      let existing = [];
      try { existing = JSON.parse(await fs.readFile(logFile, 'utf-8')); } catch { /* new file */ }
      existing.push({ type, uri, cid: cid || null, at: new Date().toISOString() });
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch { /* non-fatal */ }
  });
}

// ─── Search Seen Deduplication ───────────────────────────────────────────────

/**
 * Returns a Set of URIs already returned by search_posts this month.
 * Non-fatal: returns empty Set on any error.
 */
async function getSeenSearchUris() {
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
  const logFile = path.join(SEARCH_SEEN_PATH, `${month}.json`);
  try {
    const data = await fs.readFile(logFile, 'utf-8');
    const entries = JSON.parse(data);
    return new Set(entries.map(e => e.uri));
  } catch {
    return new Set();
  }
}

/**
 * Log URIs returned by search_posts to the seen set (fire-and-forget).
 * Also records query and timestamp for future analysis.
 */
function markSearchUrisSeen(uris, query) {
  setImmediate(async () => {
    try {
      const month = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
      const logFile = path.join(SEARCH_SEEN_PATH, `${month}.json`);
      await fs.mkdir(SEARCH_SEEN_PATH, { recursive: true });
      let existing = [];
      try { existing = JSON.parse(await fs.readFile(logFile, 'utf-8')); } catch { /* new file */ }
      const at = new Date().toISOString();
      for (const uri of uris) existing.push({ uri, query, at });
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch { /* non-fatal */ }
  });
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 1, delayMs = 2000) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// ─── Facet Rendering Verification ───────────────────────────────────────────
// After posting, fetch the post back and confirm facets are present when
// hashtags were in the text. Fires non-blocking — never delays post flow.

function verifyFacets(agent, uri, text) {
  const hashtags = detectHashtags(text);
  if (!hashtags.length) return; // nothing to verify

  // Short delay to let Bluesky index the post
  setTimeout(async () => {
    const logFile = path.join(SYSTEM_TESTS_PATH, 'facet_verification.json');
    const entry = {
      uri,
      checked_at: new Date().toISOString(),
      hashtags_in_text: hashtags,
      facets_found: false,
      facets_count: 0,
      result: 'fail'
    };
    try {
      const thread = await agent.getPostThread({ uri, depth: 0 });
      const record = thread.data?.thread?.post?.record;
      const facets = record?.facets;
      entry.facets_found = Array.isArray(facets) && facets.length > 0;
      entry.facets_count = Array.isArray(facets) ? facets.length : 0;
      entry.result = entry.facets_found ? 'pass' : 'fail';
    } catch (err) {
      entry.result = 'error';
      entry.error = err.message;
    }
    try {
      await fs.mkdir(SYSTEM_TESTS_PATH, { recursive: true });
      let existing = [];
      try {
        const data = await fs.readFile(logFile, 'utf-8');
        existing = JSON.parse(data);
      } catch { /* new file */ }
      existing.push(entry);
      await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    } catch { /* non-fatal */ }
  }, 1500);
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-social',
  version: '1.0.0',
  description: 'Bluesky social tools for Comrade Claw'
});

// ─── Tool: bluesky_post ──────────────────────────────────────────────────────

server.tool(
  'bluesky_post',
  'Post to Bluesky. 300 character limit. Distribution, not the journal itself.',
  { text: z.string().describe('Post text. Maximum 300 characters.') },
  async ({ text }) => {
    if (text.length > 300) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `Exceeds 300 char limit (${text.length} chars).` }) }] };
    }

    const { agent, RichText, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const record = await buildPostRecord(agent, RichText, text);
      const result = await withRetry(() => agent.post(record));
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logPost({ uri: result.uri, cid: result.cid, posted_at: now.toISOString(), type: 'post', char_count: text.length, hashtags: detectHashtags(text), time_of_day: timeOfDay(hour), content_type: classifyContentType(text), text_preview: text.substring(0, 100) });
      await logSharedPost('bluesky', text);
      scheduleRetrospectiveWake(result.uri, 'post');
      verifyFacets(agent, result.uri, text);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', uri: result.uri, cid: result.cid, text, charCount: text.length }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: bluesky_reply ─────────────────────────────────────────────────────

server.tool(
  'bluesky_reply',
  'Reply to someone on Bluesky. 300 char limit. Reply when there is something to say.',
  {
    uri: z.string().describe('AT URI of the post to reply to (from read_replies output).'),
    text: z.string().describe('Reply text. Maximum 300 characters.')
  },
  async ({ uri, text }) => {
    if (text.length > 300) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `Exceeds 300 char limit (${text.length} chars).` }) }] };
    }

    if (!uri.startsWith('at://') || uri.split('/').length < 5) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `Invalid AT URI. Expected format: at://did:plc:.../app.bsky.feed.post/<id>. Got: "${uri}"` }) }] };
    }

    const { agent, RichText, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const thread = await agent.getPostThread({ uri, depth: 0, parentHeight: 10 });
      const replyTo = thread.data.thread?.post;
      if (!replyTo) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Could not find post to reply to.' }) }] };
      }

      let root = thread.data.thread;
      while (root.parent?.post) root = root.parent;

      const replyRef = {
        root: { uri: root.post.uri, cid: root.post.cid },
        parent: { uri: replyTo.uri, cid: replyTo.cid }
      };

      const record = await buildPostRecord(agent, RichText, text);
      const result = await withRetry(() => agent.post({ ...record, reply: replyRef }));
      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logPost({ uri: result.uri, cid: result.cid, posted_at: now.toISOString(), type: 'reply', in_reply_to: uri, char_count: text.length, hashtags: detectHashtags(text), time_of_day: timeOfDay(hour) });
      verifyFacets(agent, result.uri, text);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', uri: result.uri, inReplyTo: uri, text, charCount: text.length }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: read_timeline ─────────────────────────────────────────────────────

server.tool(
  'read_timeline',
  'Read your own Bluesky posting history with engagement counts.',
  { count: z.coerce.number().optional().default(10).describe('Number of recent posts. Default 10, max 50.') },
  async ({ count }) => {
    const limit = Math.min(Math.max(1, count), 50);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const response = await agent.getAuthorFeed({ actor: agent.session.did, limit, filter: 'posts_no_replies' });
      const feed = response.data.feed || [];

      if (feed.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No posts found.', formatted: '' }) }] };
      }

      const blocks = feed.map(item => {
        const post = item.post;
        const text = post.record?.text || '[no text]';
        const ts = new Date(post.indexedAt).toISOString().replace('T', ' ').substring(0, 16);
        return [
          ts,
          `"${text}"`,
          `Likes: ${post.likeCount || 0} | Reposts: ${post.repostCount || 0} | Replies: ${post.replyCount || 0} | Quotes: ${post.quoteCount || 0}`,
          `[URI: ${post.uri} | CID: ${post.cid}]`
        ].join('\n');
      });

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: feed.length, formatted: blocks.join('\n\n---\n\n') }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: read_replies ──────────────────────────────────────────────────────

server.tool(
  'read_replies',
  'See who is talking to you on Bluesky. Returns replies, mentions, and quotes.',
  {
    limit: z.coerce.number().optional().default(25).describe('Max notifications. Default 25, max 50.'),
    include_read: z.boolean().optional().default(false).describe('Include already-seen notifications.')
  },
  async ({ limit, include_read }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 50);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const lastSeen = include_read ? null : await getLastSeenTimestamp();
      const response = await agent.listNotifications({ limit: fetchLimit });
      const notifications = response.data.notifications || [];

      const relevant = notifications.filter(n => ['reply', 'mention', 'quote'].includes(n.reason));
      const filtered = lastSeen
        ? relevant.filter(n => new Date(n.indexedAt) > new Date(lastSeen))
        : relevant;

      // Auto-follow-back: check new 'follow' notifications non-blocking
      const newFollowers = notifications.filter(n =>
        n.reason === 'follow' &&
        (!lastSeen || new Date(n.indexedAt) > new Date(lastSeen))
      );
      if (newFollowers.length > 0) {
        setImmediate(async () => {
          for (const notif of newFollowers) {
            try {
              const handle = notif.author.handle;
              const did = notif.author.did;
              const displayName = notif.author.displayName || handle;
              const classification = await classifyAccount(agent, handle);
              if (classification === 'organizer') {
                await withRetry(() => agent.follow(did));
                logAutoFollow(handle, did, displayName, classification);
              }
            } catch { /* non-fatal — never block notifications */ }
          }
        });
      }

      const blocks = [];
      let newestTimestamp = lastSeen;

      for (const notif of filtered) {
        const ts = new Date(notif.indexedAt);
        if (!newestTimestamp || ts > new Date(newestTimestamp)) newestTimestamp = notif.indexedAt;

        const handle = notif.author.handle;
        const displayName = notif.author.displayName || handle;
        const dateStr = ts.toISOString().replace('T', ' ').substring(0, 16);
        const replyText = notif.record?.text || '[no text]';

        let parentLine = '';
        if (notif.reason === 'reply' && notif.record?.reply?.parent?.uri) {
          try {
            const parentThread = await agent.getPostThread({ uri: notif.record.reply.parent.uri, depth: 0, parentHeight: 0 });
            const parentText = parentThread.data.thread?.post?.record?.text || '';
            if (parentText) {
              const snippet = parentText.length > 100 ? parentText.substring(0, 100) + '...' : parentText;
              parentLine = `Replying to your post: "${snippet}"`;
            }
          } catch {
            parentLine = 'Replying to your post (could not fetch text)';
          }
        } else if (notif.reason === 'mention') {
          parentLine = 'Mentioned you';
        } else if (notif.reason === 'quote') {
          parentLine = 'Quoted your post';
        }

        blocks.push([
          `@${handle} (${displayName}) — ${dateStr}`,
          parentLine,
          `"${replyText}"`,
          `[Reply URI: ${notif.uri}]`
        ].filter(Boolean).join('\n'));

        // Log engagement at ingestion time — data evaporates otherwise
        const engagementEntry = {
          timestamp: notif.indexedAt,
          handle,
          display_name: displayName,
          type: notif.reason,
          text_snippet: replyText.length > 150 ? replyText.substring(0, 150) + '...' : replyText,
          uri: notif.uri,
          classified: false
        };
        if (notif.reason === 'reply' && notif.record?.reply?.parent?.uri) {
          engagementEntry.in_reply_to_our_post = notif.record.reply.parent.uri;
        }
        // Cross-platform identity: tag with unified_id if this person is known on Mastodon too
        const blueskyUnifiedId = await getUnifiedId('bluesky', handle).catch(() => null);
        if (blueskyUnifiedId) engagementEntry.unified_id = blueskyUnifiedId;
        logEngagement(engagementEntry);
        // Non-blocking: classify account and update the log entry
        classifyEngagementAsync(agent, handle, notif.uri);
        // Non-blocking: update character last-seen if this is a known comrade
        updateCharacterLastSeen(handle, replyText.substring(0, 100)).catch(() => {});
      }

      if (newestTimestamp && !include_read) {
        await saveLastSeenTimestamp(newestTimestamp);
      }

      // Fast-response: classify new engagers in parallel (5s timeout), schedule
      // respond wake immediately if any organizer replied. Non-blocking.
      if (filtered.length > 0) {
        setImmediate(async () => {
          try {
            const timeout = new Promise(resolve => setTimeout(() => resolve([]), 5000));
            const classifications = await Promise.race([
              Promise.all(filtered.map(async n => ({
                handle: n.author.handle,
                replyText: n.record?.text,
                classification: await classifyAccount(agent, n.author.handle)
              }))),
              timeout
            ]);
            const organizers = (classifications || []).filter(c => c.classification === 'organizer');
            if (organizers.length > 0) {
              await scheduleOrganizerRespondWake(organizers);
            }
          } catch { /* non-fatal */ }
        });
      }

      // Fold unread DMs into the inbox — single call shows full inbox state
      let dmBlocks = [];
      try {
        const myDid = agent.session?.did;
        const convosRes = await chatCall(agent, 'chat.bsky.convo.listConvos', { limit: 25 });
        const convos = convosRes.data.convos || [];
        const closedHandles = await getClosedContactHandles();
        const unreadConvos = convos.filter(c => {
          if (c.unreadCount <= 0) return false;
          const others = (c.members || []).filter(m => m.did !== myDid);
          return !others.some(m => closedHandles.has(m.handle));
        });
        for (const convo of unreadConvos) {
          const others = (convo.members || []).filter(m => m.did !== myDid);
          const names = others.map(m => `@${m.handle}`).join(', ') || '(unknown)';
          const lastMsg = convo.lastMessage;
          const lastText = lastMsg?.text || '[no text]';
          const lastTs = lastMsg?.sentAt
            ? new Date(lastMsg.sentAt).toISOString().replace('T', ' ').substring(0, 16)
            : '(unknown time)';
          dmBlocks.push([
            `[DM] ${names} [${convo.unreadCount} unread] — ${lastTs}`,
            `"${lastText}"`,
            `[convoId: ${convo.id}]`
          ].join('\n'));
        }
      } catch {
        // DM check is non-fatal — notifications still returned if chat call fails
      }

      const allBlocks = [...blocks];
      if (dmBlocks.length > 0) {
        allBlocks.push(`--- DMs (${dmBlocks.length} unread) ---`);
        allBlocks.push(...dmBlocks);
      }

      if (allBlocks.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'success', count: 0, dm_count: 0,
          message: include_read ? 'No replies, mentions, quotes, or unread DMs.' : 'No new replies or unread DMs since last check.',
          formatted: ''
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        count: filtered.length,
        dm_count: dmBlocks.length,
        formatted: allBlocks.join('\n\n---\n\n')
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: reset_last_seen ───────────────────────────────────────────────────

server.tool(
  'reset_last_seen',
  'Reset the notification read cursor in last_seen.json. Use when read_replies seems stuck or to re-read all recent notifications.',
  {
    timestamp: z.string().optional().describe('Set cursor to this ISO timestamp instead of clearing it entirely. Omit to clear completely (returns all notifications next call).')
  },
  async ({ timestamp }) => {
    try {
      if (timestamp) {
        await saveLastSeenTimestamp(timestamp);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: `Cursor set to ${timestamp}` }) }] };
      } else {
        await fs.mkdir(BLUESKY_PATH, { recursive: true });
        await fs.writeFile(LAST_SEEN_PATH, JSON.stringify({ lastSeen: null }, null, 2));
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: 'Cursor cleared — next read_replies call will return all recent notifications.' }) }] };
      }
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: search_posts ──────────────────────────────────────────────────────

server.tool(
  'search_posts',
  'Search Bluesky for posts matching a keyword or phrase. Use to find conversations to engage with.',
  {
    query: z.string().describe('Search query — keywords, hashtags, phrases.'),
    limit: z.coerce.number().optional().default(20).describe('Max results. Default 20, max 50.'),
    since: z.string().optional().describe('Only return posts after this ISO 8601 datetime (e.g. "2026-01-01T00:00:00Z"). Use to filter out stale results.')
  },
  async ({ query, limit, since }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 50);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const params = { q: query, limit: fetchLimit };
      if (since) params.since = since;
      const response = await agent.app.bsky.feed.searchPosts(params);
      const allPosts = response.data.posts || [];

      if (allPosts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No posts found.', formatted: '' }) }] };
      }

      // Deduplication: filter out URIs already seen this month
      const seenUris = await getSeenSearchUris();
      const posts = allPosts.filter(post => !seenUris.has(post.uri));
      const filteredCount = allPosts.length - posts.length;

      if (posts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, filtered: filteredCount, message: `All ${filteredCount} results already seen this month. Feed exhausted for this query.`, formatted: '' }) }] };
      }

      // Mark returned URIs as seen (fire-and-forget)
      markSearchUrisSeen(posts.map(p => p.uri), query);

      const blocks = posts.map(post => {
        const handle = post.author.handle;
        const displayName = post.author.displayName || handle;
        const text = post.record?.text || '[no text]';
        const ts = new Date(post.indexedAt).toISOString().replace('T', ' ').substring(0, 16);
        return [
          `@${handle} (${displayName}) — ${ts}`,
          `"${text}"`,
          `Likes: ${post.likeCount || 0} | Reposts: ${post.repostCount || 0} | Replies: ${post.replyCount || 0}`,
          `[URI: ${post.uri} | CID: ${post.cid}]`
        ].join('\n');
      });

      const meta = filteredCount > 0 ? ` (${filteredCount} already-seen filtered out)` : '';
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: posts.length, filtered: filteredCount, query, formatted: blocks.join('\n\n---\n\n') + (meta ? `\n\n[${filteredCount} duplicate(s) suppressed]` : '') }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: search_accounts ───────────────────────────────────────────────────

server.tool(
  'search_accounts',
  'Search Bluesky for accounts by name or keyword. Use to find organizers, orgs, or accounts worth following.',
  {
    query: z.string().describe('Name or keyword to search for.'),
    limit: z.coerce.number().optional().default(10).describe('Max results. Default 10, max 25.')
  },
  async ({ query, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 25);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const response = await agent.searchActors({ q: query, limit: fetchLimit });
      const actors = response.data.actors || [];

      if (actors.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No accounts found.', formatted: '' }) }] };
      }

      const blocks = actors.map(actor => {
        const lines = [
          `@${actor.handle} — ${actor.displayName || '(no display name)'}`,
        ];
        if (actor.description) lines.push(actor.description.substring(0, 200));
        lines.push(`[DID: ${actor.did}]`);
        return lines.join('\n');
      });

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: actors.length, query, formatted: blocks.join('\n\n---\n\n') }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: like_post ─────────────────────────────────────────────────────────

server.tool(
  'like_post',
  'Like a post on Bluesky. Low-commitment way to signal solidarity or appreciation.',
  {
    uri: z.string().describe('AT URI of the post to like.'),
    cid: z.string().optional().describe('CID of the post (from search_posts or read_timeline output). Providing this skips an extra API fetch.')
  },
  async ({ uri, cid }) => {
    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    // Deduplication check — avoid liking the same post twice across wakes
    if (await hasEngaged('like', uri)) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_engaged', message: `Already liked this post this month.`, uri }) }] };
    }

    try {
      let postCid = cid;
      if (!postCid) {
        // CID not provided — fetch the post
        const thread = await agent.getPostThread({ uri, depth: 0, parentHeight: 0 });
        const post = thread.data.thread?.post;
        if (!post) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Post not found.' }) }] };
        }
        postCid = post.cid;
      }
      const result = await withRetry(() => agent.like(uri, postCid));
      logSolidarityAction('like', uri, postCid);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', liked: uri, likeUri: result.uri }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: repost ─────────────────────────────────────────────────────────────

server.tool(
  'repost',
  'Repost someone\'s Bluesky post to amplify their work.',
  {
    uri: z.string().describe('AT URI of the post to repost.'),
    cid: z.string().optional().describe('CID of the post (from search_posts or read_timeline output). Providing this skips an extra API fetch.')
  },
  async ({ uri, cid }) => {
    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    // Deduplication check — avoid reposting the same post twice across wakes
    if (await hasEngaged('repost', uri)) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_engaged', message: `Already reposted this post this month.`, uri }) }] };
    }

    try {
      let postCid = cid;
      if (!postCid) {
        // CID not provided — fetch the post
        const thread = await agent.getPostThread({ uri, depth: 0, parentHeight: 0 });
        const post = thread.data.thread?.post;
        if (!post) {
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Post not found.' }) }] };
        }
        postCid = post.cid;
      }
      const result = await withRetry(() => agent.repost(uri, postCid));
      logSolidarityAction('repost', uri, postCid);
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', reposted: uri, repostUri: result.uri }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: get_profile ────────────────────────────────────────────────────────

server.tool(
  'get_profile',
  'Get a Bluesky account\'s profile. Use before engaging to understand who you\'re talking to.',
  { handle: z.string().describe('Bluesky handle (e.g. someone.bsky.social) or DID.') },
  async ({ handle }) => {
    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const response = await agent.getProfile({ actor: handle });
      const p = response.data;

      const lines = [
        `@${p.handle} — ${p.displayName || '(no display name)'}`,
        p.description || '(no bio)',
        `Followers: ${p.followersCount || 0} | Following: ${p.followsCount || 0} | Posts: ${p.postsCount || 0}`,
        `[DID: ${p.did}]`
      ];

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', formatted: lines.join('\n') }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: get_feed ────────────────────────────────────────────────────────────

server.tool(
  'get_feed',
  'Read posts from another account\'s timeline. Use to understand what an organizer or org is posting before engaging.',
  {
    handle: z.string().describe('Bluesky handle or DID of the account to read.'),
    limit: z.coerce.number().optional().default(10).describe('Max posts. Default 10, max 30.')
  },
  async ({ handle, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 30);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const response = await agent.getAuthorFeed({ actor: handle, limit: fetchLimit, filter: 'posts_no_replies' });
      const feed = response.data.feed || [];

      if (feed.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No posts found.', formatted: '' }) }] };
      }

      const blocks = feed.map(item => {
        const post = item.post;
        const text = post.record?.text || '[no text]';
        const ts = new Date(post.indexedAt).toISOString().replace('T', ' ').substring(0, 16);
        return [
          ts,
          `"${text}"`,
          `Likes: ${post.likeCount || 0} | Reposts: ${post.repostCount || 0} | Replies: ${post.replyCount || 0}`,
          `[URI: ${post.uri} | CID: ${post.cid}]`
        ].join('\n');
      });

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', handle, count: feed.length, formatted: blocks.join('\n\n---\n\n') }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: follow_back ───────────────────────────────────────────────────────

server.tool(
  'follow_back',
  'Follow someone back, or list followers you haven\'t followed yet. No handle = show unfollowed followers list. With handle = follow that account.',
  {
    handle: z.string().optional().describe('Handle or DID to follow. Omit to list followers you aren\'t following back.'),
    limit: z.coerce.number().optional().default(50).describe('When listing unfollowed followers, max to check. Default 50, max 100.')
  },
  async ({ handle, limit }) => {
    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    // Follow a specific account
    if (handle) {
      try {
        const profileRes = await agent.getProfile({ actor: handle });
        const did = profileRes.data.did;
        const displayHandle = profileRes.data.handle;
        await withRetry(() => agent.follow(did));
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: `Now following @${displayHandle}`, did }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
      }
    }

    // List followers not followed back
    try {
      const fetchLimit = Math.min(Math.max(1, limit), 100);
      const myDid = agent.session.did;

      // Fetch followers and follows in parallel
      const [followersRes, followsRes] = await Promise.all([
        agent.getFollowers({ actor: myDid, limit: fetchLimit }),
        agent.getFollows({ actor: myDid, limit: fetchLimit })
      ]);

      const followers = followersRes.data.followers || [];
      const follows = followsRes.data.follows || [];

      const followingDids = new Set(follows.map(f => f.did));
      const unfollowed = followers.filter(f => !followingDids.has(f.did));

      if (unfollowed.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'You follow back everyone who follows you (within checked range).', formatted: '' }) }] };
      }

      const blocks = unfollowed.map(actor => {
        const lines = [`@${actor.handle} — ${actor.displayName || '(no display name)'}`];
        if (actor.description) lines.push(actor.description.substring(0, 150));
        lines.push(`[DID: ${actor.did}]`);
        return lines.join('\n');
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        count: unfollowed.length,
        message: `${unfollowed.length} follower(s) not followed back. Use follow_back with their handle to follow.`,
        formatted: blocks.join('\n\n---\n\n')
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: bluesky_thread ─────────────────────────────────────────────────────

server.tool(
  'bluesky_thread',
  'Post a connected thread of up to 10 posts. Each post chains to the previous. Use for long-form distribution, theory threads, or research findings that exceed 300 chars.',
  {
    posts: z.array(z.string()).min(2).max(10).describe('Array of 2-10 post texts, each max 300 characters. Posted in order, chained as replies.')
  },
  async ({ posts }) => {
    const oversized = posts.map((t, i) => t.length > 300 ? i : -1).filter(i => i >= 0);
    if (oversized.length > 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `Posts ${oversized.map(i => `#${i+1}`).join(', ')} exceed 300 char limit.` }) }] };
    }

    const { agent, RichText, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    const results = [];
    let rootUri = null;
    let rootCid = null;
    let prevUri = null;
    let prevCid = null;

    try {
      for (let i = 0; i < posts.length; i++) {
        const record = await buildPostRecord(agent, RichText, posts[i]);
        let postRecord;
        if (i === 0) {
          postRecord = await withRetry(() => agent.post(record));
          rootUri = postRecord.uri;
          rootCid = postRecord.cid;
        } else {
          const replyRef = {
            root: { uri: rootUri, cid: rootCid },
            parent: { uri: prevUri, cid: prevCid }
          };
          postRecord = await withRetry(() => agent.post({ ...record, reply: replyRef }));
        }
        prevUri = postRecord.uri;
        prevCid = postRecord.cid;
        results.push({ index: i + 1, uri: postRecord.uri, charCount: posts[i].length });
      }

      const now = new Date();
      const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hour12: false }));
      await logPost({ uri: rootUri, cid: rootCid, posted_at: now.toISOString(), type: 'thread', thread_length: posts.length, char_count: posts.reduce((s, p) => s + p.length, 0), hashtags: [...new Set(posts.flatMap(p => detectHashtags(p)))], time_of_day: timeOfDay(hour), content_type: classifyContentType(posts[0]), text_preview: posts[0].substring(0, 100) });
      await logSharedPost('bluesky', posts[0]);
      scheduleRetrospectiveWake(rootUri, 'thread');
      verifyFacets(agent, rootUri, posts[0]);
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        threadLength: posts.length,
        rootUri,
        posts: results
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'partial_error',
        message: err.message,
        postedSoFar: results.length,
        rootUri,
        posts: results
      }) }] };
    }
  }
);

// ─── Chat API Helper ──────────────────────────────────────────────────────────
// Bluesky DMs route through the chat proxy service at api.bsky.chat.
// All chat API calls require the atproto-proxy header.

const CHAT_PROXY_HEADER = { 'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat' };

async function chatCall(agent, method, params = {}) {
  // method: e.g. 'chat.bsky.convo.getConvoForMembers'
  // Traverse agent.api using dot-split path, tracking parent for correct `this` binding
  const parts = method.split('.');
  let obj = agent.api;
  let parent = agent.api;
  for (const part of parts) {
    parent = obj;
    obj = obj[part];
    if (obj == null) throw new Error(`Chat API method not found: ${method}`);
  }
  return obj.call(parent, params, { headers: CHAT_PROXY_HEADER });
}

// ─── Tool: bluesky_dm ────────────────────────────────────────────────────────

server.tool(
  'bluesky_dm',
  'Send a direct message to a Bluesky user. Use sparingly — only for genuine personal outreach, not broadcast.',
  {
    handle: z.string().describe('Bluesky handle (e.g. someone.bsky.social) or DID of the recipient.'),
    text: z.string().max(1000).describe('Message text. Max 1000 characters.')
  },
  async ({ handle, text }) => {
    if (text.length > 1000) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: `Exceeds 1000 char limit (${text.length} chars).` }) }] };
    }

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      // Resolve handle to DID
      const profileRes = await agent.getProfile({ actor: handle });
      const did = profileRes.data.did;
      const resolvedHandle = profileRes.data.handle;

      // Get or create conversation
      const convoRes = await chatCall(agent, 'chat.bsky.convo.getConvoForMembers', { members: [did] });
      const convoId = convoRes.data.convo.id;

      // Send message
      const msgRes = await withRetry(() =>
        chatCall(agent, 'chat.bsky.convo.sendMessage', {
          convoId,
          message: { text }
        })
      );

      logDMOutbound(resolvedHandle, text); // non-blocking: update contacts.json if tracked
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        to: resolvedHandle,
        did,
        convoId,
        messageId: msgRes.data.id,
        text,
        charCount: text.length
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: read_dms ──────────────────────────────────────────────────────────

server.tool(
  'read_dms',
  'Read your Bluesky DM inbox. Lists recent conversations with latest message from each.',
  {
    limit: z.coerce.number().optional().default(10).describe('Max conversations to list. Default 10, max 25.')
  },
  async ({ limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 25);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const convosRes = await chatCall(agent, 'chat.bsky.convo.listConvos', { limit: fetchLimit });
      const convos = convosRes.data.convos || [];

      if (convos.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No DM conversations found.', formatted: '' }) }] };
      }

      const myDid = agent.session.did;
      const closedHandles = await getClosedContactHandles();

      const blocks = convos.map(convo => {
        const others = (convo.members || []).filter(m => m.did !== myDid);
        const names = others.map(m => `@${m.handle}`).join(', ') || '(unknown)';
        const isClosed = others.some(m => closedHandles.has(m.handle));
        const lastMsg = convo.lastMessage;
        const lastText = lastMsg?.text || '[no text]';
        const lastTs = lastMsg?.sentAt
          ? new Date(lastMsg.sentAt).toISOString().replace('T', ' ').substring(0, 16)
          : '(unknown time)';
        const unread = convo.unreadCount > 0 ? ` [${convo.unreadCount} unread]` : '';
        const closedTag = isClosed ? ' [CLOSED — suppressed from read_replies]' : '';

        return [
          `${names}${unread}${closedTag} — ${lastTs}`,
          `"${lastText}"`,
          `[convoId: ${convo.id}]`
        ].join('\n');
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        count: convos.length,
        formatted: blocks.join('\n\n---\n\n')
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: get_dm_conversation ───────────────────────────────────────────────

server.tool(
  'get_dm_conversation',
  'Read the full message history for a DM conversation. Use the convoId from read_dms.',
  {
    convoId: z.string().describe('Conversation ID from read_dms output.'),
    limit: z.coerce.number().optional().default(20).describe('Max messages to return. Default 20, max 50.')
  },
  async ({ convoId, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 50);

    const { agent, error } = await getBlueskyAgent();
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_configured', message: error }) }] };

    try {
      const myDid = agent.session.did;

      // Get convo details for member handle resolution
      const convoRes = await chatCall(agent, 'chat.bsky.convo.getConvo', { convoId });
      const members = convoRes.data.convo.members || [];
      const didToHandle = {};
      for (const m of members) {
        didToHandle[m.did] = m.handle || m.did;
      }

      // Get messages (returns newest-first; reverse for chronological display)
      const msgsRes = await chatCall(agent, 'chat.bsky.convo.getMessages', { convoId, limit: fetchLimit });
      const rawMessages = msgsRes.data.messages || [];

      // Mark conversation as read so it stops appearing in read_replies unread count
      if (rawMessages.length > 0) {
        try {
          await chatCall(agent, 'chat.bsky.convo.updateRead', { convoId, messageId: rawMessages[0].id });
        } catch { /* non-fatal — marking read is best-effort */ }
      }

      const messages = rawMessages.reverse();

      const blocks = messages.map(msg => {
        const senderDid = msg.sender?.did || 'unknown';
        const senderHandle = senderDid === myDid ? 'me' : `@${didToHandle[senderDid] || senderDid}`;
        const ts = msg.sentAt
          ? new Date(msg.sentAt).toISOString().replace('T', ' ').substring(0, 16)
          : '(unknown)';
        return `[${ts}] ${senderHandle}: "${msg.text || '[no text]'}"`;
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'success',
        convoId,
        count: blocks.length,
        formatted: blocks.join('\n')
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Log Study Query Outcome ─────────────────────────────────────────────────

server.tool(
  'log_query_outcome',
  'After searching with a theory-derived query from study_queries.md, log whether it was productive or noise. Finds the matching query line and appends the outcome note inline. Call this after any search that used a query from the Theory-Derived Search Queries context block.',
  {
    query: z.string().describe('The search query that was used. Does not need to be exact — a distinctive substring is enough to find the matching line.'),
    outcome: z.enum(['productive', 'noise']).describe('"productive" if the search returned engageable content; "noise" if nothing useful came back.'),
    note: z.string().optional().describe('Optional one-line note: what was found (productive) or why it returned nothing (noise). E.g. "Hampton meal framing active thread" or "only repost chains, no discussion".')
  },
  async ({ query, outcome, note }) => {
    const sqPath = path.join(WORKSPACE_PATH, 'memory', 'study_queries.md');
    try {
      const content = await fs.readFile(sqPath, 'utf-8');
      const lines = content.split('\n');

      // Find the line that best matches the query (longest common substring match)
      const queryLower = query.toLowerCase();
      let bestIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Only look at lines that contain backtick-quoted queries or numbered list items
        if (!line.match(/^\d+\.|`/)) continue;
        const lineLower = line.toLowerCase();
        // Score: length of the longest shared segment
        let score = 0;
        for (let len = Math.min(queryLower.length, lineLower.length); len >= 6; len--) {
          for (let start = 0; start <= queryLower.length - len; start++) {
            if (lineLower.includes(queryLower.slice(start, start + len))) {
              score = len;
              break;
            }
          }
          if (score > 0) break;
        }
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx === -1) {
        // No match — append to bottom of file as fallback
        const timestamp = new Date().toISOString().substring(0, 10);
        const outcomeTag = outcome === 'productive' ? '✓' : '✗';
        const append = `\n*[${timestamp}] Unmatched outcome log — ${outcomeTag} ${outcome}${note ? ': ' + note : ''} — query: "${query.substring(0, 80)}"*`;
        await fs.appendFile(sqPath, append);
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'appended_unmatched', message: 'No matching query line found; outcome appended at end of file.' }) }] };
      }

      // Append outcome to the end of the matched line (if not already logged today)
      const timestamp = new Date().toISOString().substring(0, 10);
      const outcomeTag = outcome === 'productive' ? '✓' : '✗';
      const outcomeStr = ` **[${timestamp} ${outcomeTag} ${outcome}${note ? ': ' + note : ''}]**`;

      // Don't double-log same-date outcomes
      if (lines[bestIdx].includes(`[${timestamp}`)) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_logged', message: `Outcome already logged today for this query.`, line: lines[bestIdx] }) }] };
      }

      lines[bestIdx] = lines[bestIdx] + outcomeStr;
      await fs.writeFile(sqPath, lines.join('\n'), 'utf-8');

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'logged',
        line_number: bestIdx + 1,
        updated_line: lines[bestIdx]
      }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: update_post_log_entry ─────────────────────────────────────────────

server.tool(
  'update_post_log_entry',
  'Write engagement data back into a post log entry. Called from retrospective wakes after classifying respondents via getPostThread(). Finds the entry by URI across all monthly logs and merges {respondents, checked_at} into it. Non-fatal if the entry is not found.',
  {
    uri: z.string().describe('The Bluesky URI of the post (at://...) whose log entry should be updated.'),
    respondents: z.array(z.object({
      handle: z.string(),
      classification: z.string().describe('organizer | general | bot | unknown'),
      reply_text: z.string().optional()
    })).describe('Respondents classified from getPostThread(). Empty array if no replies.'),
    checked_at: z.string().describe('ISO timestamp when the retrospective check was performed.')
  },
  async ({ uri, respondents, checked_at }) => {
    try {
      await fs.mkdir(POSTS_LOG_PATH, { recursive: true });
      const files = await fs.readdir(POSTS_LOG_PATH);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse(); // newest first

      for (const file of jsonFiles) {
        const filePath = path.join(POSTS_LOG_PATH, file);
        let entries;
        try {
          const data = await fs.readFile(filePath, 'utf-8');
          entries = JSON.parse(data);
        } catch { continue; }

        const idx = entries.findIndex(e => e.uri === uri);
        if (idx === -1) continue;

        entries[idx] = { ...entries[idx], respondents, checked_at };
        await fs.writeFile(filePath, JSON.stringify(entries, null, 2));

        const organizers = respondents.filter(r => r.classification === 'organizer');
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'updated',
          file,
          uri,
          respondent_count: respondents.length,
          organizer_count: organizers.length,
          organizers: organizers.map(r => r.handle)
        }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_found', message: `No post log entry found for URI: ${uri}` }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
