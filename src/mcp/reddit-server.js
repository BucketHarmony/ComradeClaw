#!/usr/bin/env node
/**
 * Reddit MCP Server for Comrade Claw
 *
 * Read-only monitoring of public Reddit communities via JSON endpoints.
 * No API key, no OAuth, no browser — uses old.reddit.com/.json approach.
 * Covers ~90% of use case: monitoring labor/co-op/mutual-aid subreddits.
 *
 * Tools: reddit_fetch_subreddit, reddit_fetch_post, reddit_search,
 *        reddit_monitor_watchlist
 *
 * Watchlist: workspace/reddit/watchlist.json
 * State:     workspace/reddit/last_seen.json
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
const REDDIT_DIR = path.join(WORKSPACE_PATH, 'reddit');
const WATCHLIST_PATH = path.join(REDDIT_DIR, 'watchlist.json');
const LAST_SEEN_PATH = path.join(REDDIT_DIR, 'last_seen.json');

// ─── Rate Limiting ────────────────────────────────────────────────────────────

let consecutiveRateLimits = 0;
let circuitBroken = false;
let circuitResetAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rateLimitedFetch(url, attempt = 0) {
  if (circuitBroken && Date.now() < circuitResetAt) {
    throw new Error('Circuit breaker open — Reddit skipped for this wake');
  }
  if (circuitBroken) {
    circuitBroken = false;
    consecutiveRateLimits = 0;
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 429) {
    consecutiveRateLimits++;
    if (consecutiveRateLimits >= 3) {
      circuitBroken = true;
      circuitResetAt = Date.now() + 30 * 60 * 1000; // 30 min lockout
      throw new Error('Circuit breaker tripped — 3 consecutive 429s. Reddit skipped for 30 minutes.');
    }
    const backoffMs = Math.pow(2, attempt) * 60000; // 60s → 120s → 240s
    await sleep(backoffMs);
    return rateLimitedFetch(url, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Reddit returned HTTP ${res.status} for ${url}`);
  }

  consecutiveRateLimits = 0;
  return res;
}

// ─── Data Normalization ───────────────────────────────────────────────────────

function normalizePost(d) {
  return {
    id: d.name,           // fullname: t3_abc123
    short_id: d.id,
    title: d.title,
    author: d.author,
    subreddit: d.subreddit,
    score: d.score,
    num_comments: d.num_comments,
    url: d.url,
    selftext: d.selftext ? d.selftext.slice(0, 500) : '',
    created_utc: d.created_utc,
    permalink: `https://old.reddit.com${d.permalink}`,
    flair: d.link_flair_text || null,
    is_self: d.is_self,
  };
}

function normalizeComment(child) {
  if (!child || child.kind === 'more') return null;
  const c = child.data;
  return {
    id: c.name,
    author: c.author,
    body: c.body ? c.body.slice(0, 800) : '[deleted]',
    score: c.score,
    created_utc: c.created_utc,
  };
}

// ─── State Helpers ────────────────────────────────────────────────────────────

async function ensureDir() {
  await fs.mkdir(REDDIT_DIR, { recursive: true });
}

async function loadLastSeen() {
  try {
    return JSON.parse(await fs.readFile(LAST_SEEN_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveLastSeen(state) {
  await ensureDir();
  await fs.writeFile(LAST_SEEN_PATH, JSON.stringify(state, null, 2));
}

async function loadWatchlist() {
  try {
    return JSON.parse(await fs.readFile(WATCHLIST_PATH, 'utf-8'));
  } catch {
    return { subreddits: [] };
  }
}

// ─── Core Fetch Functions ─────────────────────────────────────────────────────

async function fetchSubreddit(subreddit, sort = 'hot', limit = 15, time = 'week') {
  const params = new URLSearchParams({ limit: String(limit) });
  if (sort === 'top') params.set('t', time);
  const url = `https://old.reddit.com/r/${subreddit}/${sort}/.json?${params}`;

  const res = await rateLimitedFetch(url);
  const data = await res.json();

  if (!data?.data?.children) throw new Error('Unexpected Reddit response shape');

  return data.data.children
    .filter(c => c.kind === 't3')
    .map(c => normalizePost(c.data));
}

async function fetchPost(permalink, commentDepth = 5) {
  let url = permalink;
  if (!url.startsWith('http')) url = `https://old.reddit.com${url}`;
  // Ensure .json suffix before query string
  url = url.replace(/(\?.*)$/, '.json$1').replace(/\/?$/, '.json').replace(/\.json\.json$/, '.json');
  if (!url.includes('.json')) url = url.replace(/\/?$/, '.json');

  const res = await rateLimitedFetch(url);
  const data = await res.json();

  if (!Array.isArray(data) || data.length < 2) throw new Error('Unexpected post response shape');

  const post = normalizePost(data[0].data.children[0].data);
  const comments = data[1].data.children
    .slice(0, commentDepth)
    .map(normalizeComment)
    .filter(Boolean);

  return { post, comments };
}

async function searchReddit(query, subreddit, sort = 'relevance', time = 'week', limit = 10) {
  const params = new URLSearchParams({ q: query, sort, t: time, limit: String(limit), type: 'link' });
  if (subreddit) params.set('restrict_sr', 'on');

  const base = subreddit
    ? `https://old.reddit.com/r/${subreddit}/search/.json`
    : `https://old.reddit.com/search/.json`;

  const res = await rateLimitedFetch(`${base}?${params}`);
  const data = await res.json();

  if (!data?.data?.children) throw new Error('Unexpected search response shape');

  return data.data.children
    .filter(c => c.kind === 't3')
    .map(c => normalizePost(c.data));
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-reddit',
  version: '2.0.0',
  description: 'Read-only Reddit monitoring via public JSON endpoints. No API key required.',
});

// ── reddit_fetch_subreddit ───────────────────────────────────────────────────

server.tool(
  'reddit_fetch_subreddit',
  'Read recent posts from a subreddit. No API key required — uses public old.reddit.com JSON endpoints.',
  {
    subreddit: z.string().describe('Subreddit name without r/ prefix (e.g. "antiwork", "cooperatives")'),
    sort: z.enum(['hot', 'new', 'top']).default('hot'),
    limit: z.number().min(1).max(25).default(15),
    time: z.enum(['day', 'week', 'month', 'year', 'all']).default('week').describe('Time range — only used when sort=top'),
  },
  async ({ subreddit, sort, limit, time }) => {
    try {
      await sleep(3000);
      const posts = await fetchSubreddit(subreddit, sort, limit, time);
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        subreddit, sort,
        fetched_at: new Date().toISOString(),
        post_count: posts.length,
        posts,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── reddit_fetch_post ────────────────────────────────────────────────────────

server.tool(
  'reddit_fetch_post',
  'Read a specific Reddit post and its top comments.',
  {
    permalink: z.string().describe('Full Reddit permalink URL or path (e.g. /r/antiwork/comments/abc123/...)'),
    comment_depth: z.number().min(1).max(20).default(5).describe('Number of top-level comments to fetch'),
  },
  async ({ permalink, comment_depth }) => {
    try {
      await sleep(3000);
      const { post, comments } = await fetchPost(permalink, comment_depth);
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        fetched_at: new Date().toISOString(),
        post, comments,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── reddit_search ────────────────────────────────────────────────────────────

server.tool(
  'reddit_search',
  'Search Reddit posts by keyword, optionally restricted to a subreddit.',
  {
    query: z.string().describe('Search query'),
    subreddit: z.string().optional().describe('Restrict to this subreddit (optional, without r/)'),
    sort: z.enum(['relevance', 'new', 'hot', 'top']).default('relevance'),
    time: z.enum(['day', 'week', 'month', 'year', 'all']).default('week'),
    limit: z.number().min(1).max(25).default(10),
  },
  async ({ query, subreddit, sort, time, limit }) => {
    try {
      await sleep(3000);
      const posts = await searchReddit(query, subreddit, sort, time, limit);
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        query,
        subreddit: subreddit || 'all',
        fetched_at: new Date().toISOString(),
        matched_count: posts.length,
        posts,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── reddit_monitor_watchlist ─────────────────────────────────────────────────

server.tool(
  'reddit_monitor_watchlist',
  'Check all watched subreddits for posts newer than last check. Updates last-seen state. Reads workspace/reddit/watchlist.json.',
  {},
  async () => {
    try {
      const watchlist = await loadWatchlist();
      if (!watchlist.subreddits?.length) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'ok', message: 'Watchlist is empty. Add subreddits to workspace/reddit/watchlist.json.',
          new_post_count: 0, new_posts: [],
        }) }] };
      }

      const lastSeen = await loadLastSeen();
      const newState = { ...lastSeen };
      const allNewPosts = [];
      let subredditsChecked = 0;
      const errors = [];

      // High priority first
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      const sorted = [...watchlist.subreddits].sort(
        (a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1)
      );

      for (const sub of sorted) {
        try {
          await sleep(3000);
          const posts = await fetchSubreddit(sub.name, 'new', 20);
          subredditsChecked++;

          const seenTime = lastSeen[sub.name]?.last_checked
            ? new Date(lastSeen[sub.name].last_checked).getTime() / 1000
            : 0;

          const newPosts = seenTime > 0
            ? posts.filter(p => p.created_utc > seenTime)
            : posts.slice(0, 5); // first run: top 5 only

          for (const post of newPosts) {
            allNewPosts.push({
              ...post,
              subreddit_category: sub.category,
              priority: sub.priority,
            });
          }

          if (posts.length > 0) {
            newState[sub.name] = {
              last_id: posts[0].id,
              last_checked: new Date().toISOString(),
            };
          }
        } catch (err) {
          errors.push({ subreddit: sub.name, error: err.message });
          if (err.message.includes('Circuit breaker')) break;
        }
      }

      await saveLastSeen(newState);

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        subreddits_checked: subredditsChecked,
        new_post_count: allNewPosts.length,
        new_posts: allNewPosts,
        errors: errors.length > 0 ? errors : undefined,
        checked_at: new Date().toISOString(),
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
