#!/usr/bin/env node
/**
 * Reddit MCP Server for Comrade Claw
 *
 * Read-only monitoring of public Reddit communities via JSON endpoints.
 * No API key, no OAuth, no browser — uses old.reddit.com/.json approach.
 * Covers ~90% of use case: monitoring labor/co-op/mutual-aid subreddits.
 *
 * Tools: reddit_fetch_subreddit, reddit_fetch_post, reddit_search,
 *        reddit_monitor_watchlist, reddit_read_inbox, reddit_post_comment
 *
 * Watchlist: workspace/reddit/watchlist.json
 * State:     workspace/reddit/last_seen.json
 *
 * OAuth (reddit_post_comment): requires REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
 * REDDIT_USERNAME, REDDIT_PASSWORD in .env. Register a "script" app at
 * https://www.reddit.com/prefs/apps to get client credentials.
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
const COMMENT_LAST_SEEN_PATH = path.join(REDDIT_DIR, 'comment_last_seen.json');
const REDDIT_LOGS_DIR = path.join(WORKSPACE_PATH, 'logs', 'reddit');

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

async function appendRedditLog(entries) {
  await fs.mkdir(REDDIT_LOGS_DIR, { recursive: true });
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const logPath = path.join(REDDIT_LOGS_DIR, `${month}.json`);
  let existing = [];
  try {
    existing = JSON.parse(await fs.readFile(logPath, 'utf-8'));
  } catch { /* first write */ }
  await fs.writeFile(logPath, JSON.stringify([...existing, ...entries], null, 2));
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

      const checkedAt = new Date().toISOString();
      const logEntries = allNewPosts.length > 0
        ? allNewPosts.map(p => ({
            checked_at: checkedAt,
            subreddit: p.subreddit,
            post_id: p.id,
            title: p.title,
            score: p.score,
            subreddit_category: p.subreddit_category || null,
            priority: p.priority || null,
            engage_attempted: false,
            engage_result: null,
          }))
        : [{ checked_at: checkedAt, subreddits_checked: subredditsChecked, posts_found: 0 }];
      await appendRedditLog(logEntries).catch(() => {}); // non-fatal

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        subreddits_checked: subredditsChecked,
        new_post_count: allNewPosts.length,
        new_posts: allNewPosts,
        errors: errors.length > 0 ? errors : undefined,
        checked_at: checkedAt,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── reddit_read_inbox ────────────────────────────────────────────────────────

async function loadCommentLastSeen() {
  try {
    return JSON.parse(await fs.readFile(COMMENT_LAST_SEEN_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function saveCommentLastSeen(state) {
  await ensureDir();
  await fs.writeFile(COMMENT_LAST_SEEN_PATH, JSON.stringify(state, null, 2));
}

/**
 * Fetch a comment's context + its replies using Reddit's permalink focus.
 * URL: /r/{sub}/comments/{post_id}/_/{comment_id}.json
 * Returns { comment, replies } where replies are direct children of the comment.
 */
async function fetchCommentReplies(subreddit, postId, commentId) {
  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}/_/${commentId}.json?context=0&limit=25`;
  const res = await rateLimitedFetch(url);
  const data = await res.json();

  if (!Array.isArray(data) || data.length < 2) {
    throw new Error('Unexpected comment context response shape');
  }

  // data[1] contains the comment tree focused on commentId
  const listing = data[1].data.children;
  if (!listing?.length) return { comment: null, replies: [] };

  // Find our comment in the listing
  const focused = listing.find(c => c.kind === 't1' && c.data.id === commentId);
  if (!focused) return { comment: null, replies: [] };

  const comment = focused.data;
  const replies = [];

  if (comment.replies && comment.replies.data?.children) {
    for (const child of comment.replies.data.children) {
      if (child.kind === 'more') continue;
      const c = child.data;
      replies.push({
        id: c.name,          // t1_xxx
        short_id: c.id,
        author: c.author,
        body: c.body ? c.body.slice(0, 600) : '[deleted]',
        score: c.score,
        created_utc: c.created_utc,
        permalink: `https://old.reddit.com${c.permalink}`,
      });
    }
  }

  return {
    comment: {
      id: comment.name,
      short_id: comment.id,
      body: comment.body ? comment.body.slice(0, 300) : '[deleted]',
      subreddit: comment.subreddit,
      link_title: comment.link_title || null,
      permalink: `https://old.reddit.com${comment.permalink}`,
      score: comment.score,
      created_utc: comment.created_utc,
    },
    replies,
  };
}

server.tool(
  'reddit_read_inbox',
  'Check for new replies to tracked Reddit comments. Reads workspace/reddit/comment_last_seen.json, re-fetches each comment thread, surfaces replies not yet seen. Call this each wake alongside mastodon_read_notifications.',
  {
    mark_seen: z.boolean().default(true).describe('Mark new replies as seen (updates comment_last_seen.json)'),
  },
  async ({ mark_seen }) => {
    try {
      const tracked = await loadCommentLastSeen();
      const commentIds = Object.keys(tracked);

      if (commentIds.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'ok',
          message: 'No tracked comments. When you comment on Reddit, add the comment ID to workspace/reddit/comment_last_seen.json.',
          new_reply_count: 0,
          new_replies: [],
        }) }] };
      }

      const updatedState = { ...tracked };
      const allNewReplies = [];
      const errors = [];

      for (const commentFullname of commentIds) {
        const entry = tracked[commentFullname];
        // commentFullname is t1_xxx; extract short ID
        const shortId = commentFullname.startsWith('t1_')
          ? commentFullname.slice(3)
          : commentFullname;

        // Need subreddit + post_id to build the URL. Parse from permalink.
        // permalink format: /r/{sub}/comments/{post_id}/...
        const permalink = entry.permalink || '';
        const match = permalink.match(/\/r\/([^/]+)\/comments\/([^/]+)/);
        if (!match) {
          errors.push({ comment_id: commentFullname, error: 'No valid permalink stored — cannot fetch replies' });
          continue;
        }

        const [, subreddit, postId] = match;

        try {
          await sleep(3000);
          const { comment, replies } = await fetchCommentReplies(subreddit, postId, shortId);

          const seenIds = new Set(entry.reply_ids_seen || []);
          const newReplies = replies.filter(r => !seenIds.has(r.id));

          if (newReplies.length > 0) {
            for (const reply of newReplies) {
              allNewReplies.push({
                parent_comment_id: commentFullname,
                parent_comment_text: entry.comment_text || comment?.body || '',
                parent_thread_title: entry.thread_title || comment?.link_title || '',
                parent_permalink: entry.permalink,
                ...reply,
              });
            }
          }

          if (mark_seen) {
            updatedState[commentFullname] = {
              ...entry,
              last_checked: new Date().toISOString(),
              reply_ids_seen: [...(entry.reply_ids_seen || []), ...newReplies.map(r => r.id)],
            };
          }
        } catch (err) {
          errors.push({ comment_id: commentFullname, error: err.message });
          if (err.message.includes('Circuit breaker')) break;
        }
      }

      if (mark_seen) {
        await saveCommentLastSeen(updatedState);
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        comments_checked: commentIds.length - errors.length,
        new_reply_count: allNewReplies.length,
        new_replies: allNewReplies,
        errors: errors.length > 0 ? errors : undefined,
        checked_at: new Date().toISOString(),
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── reddit_post_comment ──────────────────────────────────────────────────────

// ─── Pre-flight Quality Gate ──────────────────────────────────────────────────

async function fetchPostMeta(permalink) {
  let url = permalink;
  if (!url.startsWith('http')) url = `https://old.reddit.com${url}`;
  if (!url.includes('.json')) url = url.replace(/\/?$/, '.json');
  url = `${url}?limit=0`;

  const res = await rateLimitedFetch(url);
  const data = await res.json();

  if (!Array.isArray(data) || !data[0]?.data?.children?.[0]) {
    throw new Error('Could not parse post metadata from Reddit response');
  }

  const post = data[0].data.children[0].data;
  return {
    locked: post.locked || false,
    archived: post.archived || false,
    subreddit: post.subreddit,
  };
}

async function preflightCheck(text, permalink, watchlist) {
  const failures = [];

  // Check 1: minimum length
  if (text.length < 80) {
    failures.push({
      check: 'min_length',
      reason: `Comment is ${text.length} chars (minimum 80). One-liners damage credibility — expand the argument or don't post.`,
      blocking: true,
    });
  }

  // Check 2 + 3: post status and subreddit whitelist (requires one API call)
  try {
    await sleep(3000); // rate-limit respect
    const meta = await fetchPostMeta(permalink);

    const watchedNames = new Set((watchlist.subreddits || []).map(s => s.name.toLowerCase()));
    if (!watchedNames.has(meta.subreddit.toLowerCase())) {
      failures.push({
        check: 'subreddit_not_approved',
        reason: `r/${meta.subreddit} is not in the watchlist. Posting there risks off-mission drift. Add it to workspace/reddit/watchlist.json first, or pass force: true.`,
        blocking: true,
      });
    }

    if (meta.locked) {
      failures.push({
        check: 'post_locked',
        reason: `Post in r/${meta.subreddit} is locked. Comment will fail silently.`,
        blocking: true,
      });
    }

    if (meta.archived) {
      failures.push({
        check: 'post_archived',
        reason: `Post in r/${meta.subreddit} is archived (>6 months old). Commenting is disabled.`,
        blocking: true,
      });
    }
  } catch (err) {
    // Non-fatal: can't verify post status, warn but don't block
    failures.push({
      check: 'meta_fetch_warning',
      reason: `Could not verify post status (${err.message}). Proceeding may fail silently.`,
      blocking: false,
    });
  }

  return failures;
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * Reddit OAuth token cache (in-process; lasts as long as the MCP server runs).
 * Tokens are valid for ~24h. We cache to avoid re-authing on every comment.
 */
const _oauthCache = { token: null, expiresAt: 0 };

async function getRedditOAuthToken() {
  if (_oauthCache.token && Date.now() < _oauthCache.expiresAt) {
    return _oauthCache.token;
  }

  const clientId     = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username     = process.env.REDDIT_USERNAME;
  const password     = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Reddit OAuth not configured. Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in .env. ' +
      'Register a "script" app at https://www.reddit.com/prefs/apps to get credentials.'
    );
  }
  if (!username || !password) {
    throw new Error('REDDIT_USERNAME and REDDIT_PASSWORD must be set in .env');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ComradeClaw/1.0 (by /u/Calm_Delivery6725)',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit OAuth failed: HTTP ${res.status} — ${text}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Reddit OAuth error: ${data.error}`);
  }

  // Cache with 5-min buffer before actual expiry
  _oauthCache.token = data.access_token;
  _oauthCache.expiresAt = Date.now() + (data.expires_in - 300) * 1000;
  return _oauthCache.token;
}

server.tool(
  'reddit_post_comment',
  'Post a comment on Reddit (reply to a post or another comment). Requires REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET in .env (ROPC OAuth). On success, auto-registers the new comment in comment_last_seen.json so reddit_read_inbox tracks replies to it. Pre-flight gate: checks min length (80 chars), subreddit is in watchlist, post is not locked/archived. Pass force: true to bypass.',
  {
    parent_fullname: z.string().describe(
      'Fullname of the thing to reply to: post fullname (t3_xxx) or comment fullname (t1_xxx). ' +
      'Get from reddit_fetch_subreddit (post.id) or reddit_fetch_post (comment.id).'
    ),
    text: z.string().min(1).max(10000).describe('Comment body in plain text (Markdown supported).'),
    permalink: z.string().describe(
      'Permalink of the parent post (e.g. /r/cooperatives/comments/abc123/...). ' +
      'Required so reply tracking knows which thread to re-fetch.'
    ),
    thread_title: z.string().optional().describe('Thread title — stored in tracking for context.'),
    force: z.boolean().default(false).describe(
      'Bypass the pre-flight quality gate (min length, subreddit whitelist, post locked/archived). ' +
      'Use deliberately for exceptions — gate failure message will say when force is appropriate.'
    ),
  },
  async ({ parent_fullname, text, permalink, thread_title, force }) => {
    try {
      // ── Pre-flight quality gate ──────────────────────────────────────────
      let preflightWarnings = [];
      if (!force) {
        const watchlist = await loadWatchlist();
        const failures = await preflightCheck(text, permalink, watchlist);
        const blocking = failures.filter(f => f.blocking);

        if (blocking.length > 0) {
          return { content: [{ type: 'text', text: JSON.stringify({
            status: 'preflight_failed',
            message: 'Comment blocked by pre-flight quality gate. Fix the issues or pass force: true to bypass.',
            failures,
            bypass_hint: 'force: true skips all checks — use deliberately.',
          }, null, 2) }] };
        }

        preflightWarnings = failures.filter(f => !f.blocking);
      }

      const token = await getRedditOAuthToken();

      const body = new URLSearchParams({
        api_type: 'json',
        thing_id: parent_fullname,
        text,
      });

      const res = await fetch('https://oauth.reddit.com/api/comment', {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'ComradeClaw/1.0 (by /u/Calm_Delivery6725)',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'error',
          message: `Reddit API returned HTTP ${res.status}: ${errText}`,
        }) }] };
      }

      const data = await res.json();
      const errors = data?.json?.errors;
      if (errors?.length) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'error',
          message: `Reddit API errors: ${errors.map(e => e.join(': ')).join('; ')}`,
        }) }] };
      }

      // Extract the new comment's fullname from the response
      const things = data?.json?.data?.things;
      const newComment = things?.[0]?.data;
      const newCommentId   = newComment ? `t1_${newComment.id}` : null;
      const newPermalink   = newComment?.permalink
        ? `/r/${newComment.subreddit}/comments/${newComment.link_id?.replace('t3_','')}/x/${newComment.id}/`
        : permalink;

      // Auto-register in comment_last_seen.json for reply tracking
      if (newCommentId) {
        const tracked = await loadCommentLastSeen();
        tracked[newCommentId] = {
          permalink: newPermalink,
          comment_text: text.slice(0, 150),
          thread_title: thread_title || '',
          posted_at: new Date().toISOString(),
          last_checked: null,
          reply_ids_seen: [],
        };
        await saveCommentLastSeen(tracked);
      }

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        comment_id: newCommentId,
        permalink: newPermalink,
        parent_fullname,
        text_preview: text.slice(0, 100),
        tracked: !!newCommentId,
        posted_at: new Date().toISOString(),
        ...(preflightWarnings.length > 0 ? { warnings: preflightWarnings } : {}),
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'error',
        message: err.message,
      }) }] };
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
