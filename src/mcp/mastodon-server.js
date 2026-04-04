#!/usr/bin/env node
/**
 * Mastodon MCP Server for Comrade Claw
 *
 * Exposes Mastodon tools via the Model Context Protocol (stdio transport).
 * Tools: mastodon_post, mastodon_reply, mastodon_read_timeline,
 *        mastodon_read_notifications, mastodon_boost, mastodon_favourite,
 *        mastodon_search
 *
 * Requires env: MASTODON_INSTANCE, MASTODON_ACCESS_TOKEN
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');
const MASTODON_ENGAGEMENT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'engagement');
const MASTODON_FOLLOWS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'follows');

const INSTANCE = process.env.MASTODON_INSTANCE || 'https://mastodon.social';
const TOKEN = process.env.MASTODON_ACCESS_TOKEN;

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
  for (const n of highSignal) {
    try {
      await appendToMonthlyLog(MASTODON_ENGAGEMENT_LOG_PATH, {
        platform: 'mastodon',
        timestamp: n.created_at,
        handle: n.account,
        type: n.type,
        status_id: n.status_id,
        text_snippet: n.status_content ? n.status_content.substring(0, 150) : null,
        status_url: n.status_url,
        logged_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }
  }
}

// ─── Mastodon Auto-Follow-Back ───────────────────────────────────────────────

const MASTODON_ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'coop', 'mutual aid', 'union', 'labor', 'labour',
  'organiz', 'solidarity', 'worker', 'collective', 'community fridge',
  'dual power', 'strike', 'syndicalist', 'socialist', 'communist',
  'leftist', 'abolition', 'tenant', 'housing', 'autonomy', 'anarchist'
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
        status_content: n.status?.content?.replace(/<[^>]*>/g, ''),
        status_url: n.status?.url,
      }));
      // Log high-signal notifications (mentions, reblogs) for Karpathy Loop visibility
      await logMastodonNotifications(items).catch(() => {});
      // Auto-follow-back organizer followers — non-blocking
      autoFollowBackMastodonOrganizers(notifications);
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
        items = (result.statuses || []).map((s) => ({
          id: s.id,
          account: s.account.acct,
          content: s.content.replace(/<[^>]*>/g, '').slice(0, 400),
          created_at: s.created_at,
          url: s.url,
          reblogs: s.reblogs_count,
          favourites: s.favourites_count,
        }));
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

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
