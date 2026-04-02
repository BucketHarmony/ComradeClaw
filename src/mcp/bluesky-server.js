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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');
const BLUESKY_PATH = path.join(WORKSPACE_PATH, 'bluesky');
const LAST_SEEN_PATH = path.join(BLUESKY_PATH, 'last_seen.json');
const POSTS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'posts');
const ENGAGEMENT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'engagement');

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

// ─── Rich Text Helper ────────────────────────────────────────────────────────
// Detects hashtags, @mentions, and URLs in post text and returns a record
// with facets so they render as clickable on Bluesky.
async function buildPostRecord(agent, RichText, text) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  return rt.facets?.length ? { text: rt.text, facets: rt.facets } : { text };
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

async function logPost(entry) {
  try {
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(POSTS_LOG_PATH, `${month}.json`);
    await fs.mkdir(POSTS_LOG_PATH, { recursive: true });
    let existing = [];
    try {
      const data = await fs.readFile(logFile, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* new file */ }
    existing.push(entry);
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal — never break the post flow */ }
}

async function logEngagement(entry) {
  try {
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(ENGAGEMENT_LOG_PATH, `${month}.json`);
    await fs.mkdir(ENGAGEMENT_LOG_PATH, { recursive: true });
    let existing = [];
    try {
      const data = await fs.readFile(logFile, 'utf-8');
      existing = JSON.parse(data);
    } catch { /* new file */ }
    existing.push(entry);
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
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
      await logPost({ uri: result.uri, cid: result.cid, posted_at: now.toISOString(), type: 'post', char_count: text.length, hashtags: detectHashtags(text), time_of_day: timeOfDay(hour) });
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

      if (filtered.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'success', count: 0,
          message: include_read ? 'No replies, mentions, or quotes found.' : 'No new replies since last check.',
          formatted: ''
        }) }] };
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
        logEngagement({
          timestamp: notif.indexedAt,
          handle,
          display_name: displayName,
          type: notif.reason,
          text_snippet: replyText.length > 150 ? replyText.substring(0, 150) + '...' : replyText,
          uri: notif.uri,
          classified: false
        });
      }

      if (newestTimestamp && !include_read) {
        await saveLastSeenTimestamp(newestTimestamp);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: filtered.length, formatted: blocks.join('\n\n---\n\n') }) }] };
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
      const posts = response.data.posts || [];

      if (posts.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: 0, message: 'No posts found.', formatted: '' }) }] };
      }

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

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', count: posts.length, query, formatted: blocks.join('\n\n---\n\n') }) }] };
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
      await logPost({ uri: rootUri, cid: rootCid, posted_at: now.toISOString(), type: 'thread', thread_length: posts.length, char_count: posts.reduce((s, p) => s + p.length, 0), hashtags: [...new Set(posts.flatMap(p => detectHashtags(p)))], time_of_day: timeOfDay(hour) });
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

      const blocks = convos.map(convo => {
        const others = (convo.members || []).filter(m => m.did !== myDid);
        const names = others.map(m => `@${m.handle}`).join(', ') || '(unknown)';
        const lastMsg = convo.lastMessage;
        const lastText = lastMsg?.text || '[no text]';
        const lastTs = lastMsg?.sentAt
          ? new Date(lastMsg.sentAt).toISOString().replace('T', ' ').substring(0, 16)
          : '(unknown time)';
        const unread = convo.unreadCount > 0 ? ` [${convo.unreadCount} unread]` : '';

        return [
          `${names}${unread} — ${lastTs}`,
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

// ─── Start Server ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
