#!/usr/bin/env node
/**
 * Reddit MCP Server for Comrade Claw
 *
 * Exposes Reddit tools via the Model Context Protocol (stdio transport).
 * Tools: reddit_post, reddit_comment, reddit_search, reddit_get_hot,
 *        reddit_get_post, reddit_read_inbox, reddit_search_subreddits
 *
 * Requires env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
 *               REDDIT_USERNAME, REDDIT_PASSWORD
 *
 * Uses Reddit OAuth2 script-app password grant (no user auth flow needed).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_AUTH_URL = 'https://www.reddit.com/api/v1/access_token';

// ─── Reddit Auth Helper ──────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

function getUserAgent() {
  const username = process.env.REDDIT_USERNAME || 'ComradeClaw';
  return `ComradeClaw/1.0 by u/${username}`;
}

async function getRedditToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) {
    return { token: _cachedToken };
  }

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  if (!clientId || !clientSecret || !username || !password) {
    return { error: 'REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, and REDDIT_PASSWORD must be set.' };
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'password',
      username,
      password
    });

    const res = await fetch(REDDIT_AUTH_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'User-Agent': getUserAgent(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });

    if (!res.ok) {
      const text = await res.text();
      return { error: `Reddit auth failed (${res.status}): ${text}` };
    }

    const data = await res.json();
    if (data.error) {
      return { error: `Reddit auth error: ${data.error}` };
    }

    _cachedToken = data.access_token;
    // Expire 5 min early to avoid edge cases
    _tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return { token: _cachedToken };
  } catch (err) {
    return { error: `Reddit auth exception: ${err.message}` };
  }
}

// ─── Reddit API Helper ───────────────────────────────────────────────────────

async function redditFetch(path, options = {}) {
  const { token, error } = await getRedditToken();
  if (error) return { error };

  const url = path.startsWith('http') ? path : `${REDDIT_OAUTH_BASE}${path}`;
  const method = options.method || 'GET';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': getUserAgent(),
    ...(options.headers || {})
  };

  if (options.body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  try {
    const res = await fetch(url, { method, headers, body: options.body });

    if (res.status === 429) {
      return { error: 'Rate limited by Reddit. Try again in a moment.' };
    }

    if (!res.ok) {
      const text = await res.text();
      return { error: `Reddit API error (${res.status}): ${text.substring(0, 300)}` };
    }

    const data = await res.json();
    if (data.error) {
      return { error: `Reddit error: ${data.error} — ${data.message || ''}` };
    }

    return { data };
  } catch (err) {
    return { error: `Reddit fetch exception: ${err.message}` };
  }
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

function formatPost(post) {
  const p = post.data || post;
  const ts = new Date(p.created_utc * 1000).toISOString().replace('T', ' ').substring(0, 16);
  const lines = [
    `r/${p.subreddit} — u/${p.author} — ${ts}`,
    `"${p.title}"`,
  ];
  if (p.selftext && p.selftext !== '[removed]' && p.selftext !== '[deleted]') {
    const body = p.selftext.length > 300 ? p.selftext.substring(0, 300) + '...' : p.selftext;
    lines.push(body);
  } else if (p.url && !p.url.includes('reddit.com')) {
    lines.push(`URL: ${p.url}`);
  }
  lines.push(`Score: ${p.score} | Comments: ${p.num_comments} | Upvote ratio: ${Math.round((p.upvote_ratio || 0) * 100)}%`);
  lines.push(`[ID: ${p.name || 't3_' + p.id}] [https://reddit.com${p.permalink}]`);
  return lines.join('\n');
}

function formatComment(comment) {
  const c = comment.data || comment;
  const ts = new Date(c.created_utc * 1000).toISOString().replace('T', ' ').substring(0, 16);
  const body = c.body?.length > 500 ? c.body.substring(0, 500) + '...' : c.body || '[no text]';
  return [
    `u/${c.author} — r/${c.subreddit} — ${ts}`,
    `"${body}"`,
    `Score: ${c.score}`,
    `[ID: ${c.name || 't1_' + c.id}] [https://reddit.com${c.permalink}]`
  ].join('\n');
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-reddit',
  version: '1.0.0',
  description: 'Reddit tools for Comrade Claw'
});

// ─── Tool: reddit_post ───────────────────────────────────────────────────────

server.tool(
  'reddit_post',
  'Submit a text post to a subreddit. Use for longer-form content, theory drops, or linking to Bluesky threads.',
  {
    subreddit: z.string().describe('Subreddit name without r/ prefix (e.g. "cooperatives", "MutualAid").'),
    title: z.string().max(300).describe('Post title. Max 300 characters.'),
    text: z.string().optional().describe('Post body text (selftext). Optional — omit for link posts.')
  },
  async ({ subreddit, title, text }) => {
    const body = new URLSearchParams({
      kind: 'self',
      sr: subreddit,
      title,
      text: text || '',
      resubmit: 'true',
      nsfw: 'false',
      spoiler: 'false'
    });

    const result = await redditFetch('/api/submit', { method: 'POST', body: body.toString() });
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const json = result.data?.json;
    if (json?.errors?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: json.errors.join('; ') }) }] };
    }

    const postData = json?.data;
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      url: postData?.url,
      id: postData?.id,
      subreddit,
      title
    }) }] };
  }
);

// ─── Tool: reddit_comment ────────────────────────────────────────────────────

server.tool(
  'reddit_comment',
  'Reply to a Reddit post or comment. thing_id is the fullname (t3_xxx for posts, t1_xxx for comments).',
  {
    thing_id: z.string().describe('Fullname of the post or comment to reply to (e.g. "t3_abc123" or "t1_def456").'),
    text: z.string().describe('Comment text in markdown. No enforced limit but keep it substantive.')
  },
  async ({ thing_id, text }) => {
    const body = new URLSearchParams({
      parent: thing_id,
      text
    });

    const result = await redditFetch('/api/comment', { method: 'POST', body: body.toString() });
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const json = result.data?.json;
    if (json?.errors?.length) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: json.errors.join('; ') }) }] };
    }

    const commentData = json?.data?.things?.[0]?.data;
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      id: commentData?.name,
      permalink: commentData?.permalink ? `https://reddit.com${commentData.permalink}` : undefined,
      parent: thing_id
    }) }] };
  }
);

// ─── Tool: reddit_search ─────────────────────────────────────────────────────

server.tool(
  'reddit_search',
  'Search Reddit posts by keyword. Use to find conversations about cooperatives, mutual aid, labor organizing.',
  {
    query: z.string().describe('Search query — keywords or phrases.'),
    subreddit: z.string().optional().describe('Restrict to a specific subreddit (without r/). Omit to search all of Reddit.'),
    sort: z.enum(['relevance', 'new', 'hot', 'top']).optional().default('new').describe('Sort order. Default: new.'),
    limit: z.number().optional().default(15).describe('Max results. Default 15, max 25.')
  },
  async ({ query, subreddit, sort, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 25);
    const base = subreddit ? `/r/${subreddit}/search.json` : '/search.json';
    const params = new URLSearchParams({
      q: query,
      sort,
      limit: String(fetchLimit),
      type: 'link',
      ...(subreddit ? { restrict_sr: 'true' } : {})
    });

    const result = await redditFetch(`${base}?${params}`);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const posts = result.data?.data?.children || [];
    if (posts.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No results found.', formatted: '' }) }] };
    }

    const blocks = posts.map(p => formatPost(p));
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      count: posts.length,
      query,
      formatted: blocks.join('\n\n---\n\n')
    }) }] };
  }
);

// ─── Tool: reddit_get_hot ────────────────────────────────────────────────────

server.tool(
  'reddit_get_hot',
  'Get hot posts from a subreddit. Use to understand what\'s active in a community before posting.',
  {
    subreddit: z.string().describe('Subreddit name without r/ prefix.'),
    limit: z.number().optional().default(10).describe('Max posts. Default 10, max 25.')
  },
  async ({ subreddit, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 25);
    const result = await redditFetch(`/r/${subreddit}/hot.json?limit=${fetchLimit}`);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const posts = result.data?.data?.children || [];
    const realPosts = posts.filter(p => !p.data?.stickied);

    if (realPosts.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: `No posts found in r/${subreddit}.`, formatted: '' }) }] };
    }

    const blocks = realPosts.map(p => formatPost(p));
    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      subreddit,
      count: realPosts.length,
      formatted: blocks.join('\n\n---\n\n')
    }) }] };
  }
);

// ─── Tool: reddit_get_post ───────────────────────────────────────────────────

server.tool(
  'reddit_get_post',
  'Get a Reddit post and its top comments. Use before commenting to read the thread.',
  {
    post_id: z.string().describe('Post ID or fullname (t3_xxx or just the ID like "abc123").'),
    subreddit: z.string().describe('Subreddit the post is in (without r/).'),
    comment_limit: z.number().optional().default(10).describe('Number of top-level comments to fetch. Default 10, max 25.')
  },
  async ({ post_id, subreddit, comment_limit }) => {
    const id = post_id.startsWith('t3_') ? post_id.slice(3) : post_id;
    const fetchLimit = Math.min(Math.max(1, comment_limit), 25);
    const result = await redditFetch(`/r/${subreddit}/comments/${id}.json?limit=${fetchLimit}&depth=2`);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const listing = result.data;
    if (!Array.isArray(listing) || listing.length < 1) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Unexpected response structure.' }) }] };
    }

    const post = listing[0]?.data?.children?.[0];
    const comments = listing[1]?.data?.children || [];

    const postBlock = post ? formatPost(post) : '[post not found]';
    const commentBlocks = comments
      .filter(c => c.kind === 't1')
      .map(c => formatComment(c));

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      post: postBlock,
      commentCount: commentBlocks.length,
      comments: commentBlocks.join('\n\n---\n\n')
    }) }] };
  }
);

// ─── Tool: reddit_read_inbox ─────────────────────────────────────────────────

server.tool(
  'reddit_read_inbox',
  'Read Reddit inbox — replies, mentions, and messages. Returns unread by default.',
  {
    filter: z.enum(['unread', 'inbox', 'mentions', 'comments']).optional().default('unread').describe('Which messages to fetch. Default: unread.'),
    limit: z.number().optional().default(25).describe('Max items. Default 25, max 50.')
  },
  async ({ filter, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 50);
    const result = await redditFetch(`/message/${filter}.json?limit=${fetchLimit}`);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const items = result.data?.data?.children || [];
    if (items.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: `No ${filter} messages.`, formatted: '' }) }] };
    }

    const blocks = items.map(item => {
      const d = item.data;
      const ts = new Date(d.created_utc * 1000).toISOString().replace('T', ' ').substring(0, 16);
      const body = d.body?.length > 500 ? d.body.substring(0, 500) + '...' : d.body || '[no text]';
      return [
        `From: u/${d.author} — ${ts} — ${d.was_comment ? 'comment reply' : 'message'}`,
        d.subject ? `Subject: ${d.subject}` : null,
        d.was_comment ? `In: r/${d.subreddit}` : null,
        `"${body}"`,
        `[ID: ${d.name}]`
      ].filter(Boolean).join('\n');
    });

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      count: items.length,
      filter,
      formatted: blocks.join('\n\n---\n\n')
    }) }] };
  }
);

// ─── Tool: reddit_search_subreddits ─────────────────────────────────────────

server.tool(
  'reddit_search_subreddits',
  'Find subreddits by topic. Use to discover relevant communities before posting.',
  {
    query: z.string().describe('Topic or keyword to search for.'),
    limit: z.number().optional().default(10).describe('Max results. Default 10, max 20.')
  },
  async ({ query, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit), 20);
    const params = new URLSearchParams({ q: query, limit: String(fetchLimit) });
    const result = await redditFetch(`/subreddits/search.json?${params}`);
    if (result.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: result.error }) }] };
    }

    const subs = result.data?.data?.children || [];
    if (subs.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No subreddits found.', formatted: '' }) }] };
    }

    const blocks = subs.map(item => {
      const s = item.data;
      const lines = [
        `r/${s.display_name} — ${s.title || ''}`,
        s.public_description ? s.public_description.substring(0, 200) : '(no description)',
        `Members: ${s.subscribers?.toLocaleString() || '?'} | Type: ${s.subreddit_type || '?'}`
      ];
      return lines.join('\n');
    });

    return { content: [{ type: 'text', text: JSON.stringify({
      status: 'success',
      count: subs.length,
      query,
      formatted: blocks.join('\n\n---\n\n')
    }) }] };
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
