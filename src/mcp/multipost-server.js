#!/usr/bin/env node
/**
 * Multi-Platform Posting MCP Server for Comrade Claw
 *
 * Post to Bluesky AND Mastodon in a single tool call.
 * Handles character limit differences automatically.
 * Supports per-platform text overrides for nuanced messaging.
 *
 * Tools:
 *   multipost    — post to both platforms simultaneously
 *   multireply   — reply to threads on both platforms at once
 *   shoutout     — name-check a comrade on both platforms (positive callout)
 *
 * Requires env:
 *   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD
 *   MASTODON_INSTANCE, MASTODON_ACCESS_TOKEN
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
const POSTS_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'posts');

// ─── Bluesky Auth ─────────────────────────────────────────────────────────────

let _bskyAgent = null;
let _bskyExpiry = 0;
let _RichText = null;

async function getBlueskyAgent() {
  if (_bskyAgent && Date.now() < _bskyExpiry) {
    return { agent: _bskyAgent, RichText: _RichText };
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
    _bskyAgent = agent;
    _RichText = RichText;
    _bskyExpiry = Date.now() + 10 * 60 * 1000;
    return { agent, RichText };
  } catch (err) {
    return { error: `Bluesky login failed: ${err.message}` };
  }
}

async function buildPostRecord(agent, RichText, text) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  return rt.facets?.length ? { text: rt.text, facets: rt.facets } : { text };
}

async function withRetry(fn, retries = 1, delayMs = 2000) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return withRetry(fn, retries - 1, delayMs);
  }
}

// ─── Mastodon API ─────────────────────────────────────────────────────────────

const MASTO_INSTANCE = process.env.MASTODON_INSTANCE || 'https://mastodon.social';
const MASTO_TOKEN = process.env.MASTODON_ACCESS_TOKEN;

async function masto(endpoint, options = {}) {
  if (!MASTO_TOKEN) throw new Error('MASTODON_ACCESS_TOKEN not set');
  const url = endpoint.startsWith('/api/')
    ? `${MASTO_INSTANCE}${endpoint}`
    : `${MASTO_INSTANCE}/api/v1${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${MASTO_TOKEN}`,
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

// ─── Logging ──────────────────────────────────────────────────────────────────

async function logMultipost(entry) {
  try {
    const now = new Date();
    const month = now.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    const logFile = path.join(POSTS_LOG_PATH, `multipost-${month}.json`);
    await fs.mkdir(POSTS_LOG_PATH, { recursive: true });
    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch { /* new file */ }
    existing.push({ ...entry, logged_at: now.toISOString() });
    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
  } catch { /* non-fatal */ }
}

// ─── Core Post Logic ──────────────────────────────────────────────────────────

/**
 * Post to Bluesky. Returns { status, uri, cid } or { status: 'error', message }.
 */
async function postToBluesky(text) {
  if (text.length > 300) {
    return { status: 'error', message: `Bluesky: exceeds 300 char limit (${text.length} chars)` };
  }
  const { agent, RichText, error } = await getBlueskyAgent();
  if (error) return { status: 'not_configured', message: error };
  try {
    const record = await buildPostRecord(agent, RichText, text);
    const result = await withRetry(() => agent.post(record));
    return { status: 'success', uri: result.uri, cid: result.cid, char_count: text.length };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * Post to Mastodon. Returns { status, id, url } or { status: 'error', message }.
 */
async function postToMastodon(text, visibility = 'public') {
  if (text.length > 500) {
    return { status: 'error', message: `Mastodon: exceeds 500 char limit (${text.length} chars)` };
  }
  try {
    const status = await masto('/statuses', {
      method: 'POST',
      body: JSON.stringify({ status: text, visibility }),
    });
    return { status: 'success', id: status.id, url: status.url, char_count: text.length };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-multipost',
  version: '1.0.0',
  description: 'Multi-platform posting for Comrade Claw — Bluesky + Mastodon in one call',
});

// ─── Tool: multipost ──────────────────────────────────────────────────────────

server.tool(
  'multipost',
  'Post to both Bluesky (300 char) and Mastodon (500 char) simultaneously. Provide a base text or platform-specific overrides. One platform failing does not block the other.',
  {
    text: z.string().optional().describe('Base post text used for both platforms if overrides not given.'),
    bluesky_text: z.string().max(300).optional().describe('Bluesky-specific text (max 300 chars). Overrides base text for Bluesky.'),
    mastodon_text: z.string().max(500).optional().describe('Mastodon-specific text (max 500 chars). Overrides base text for Mastodon.'),
    platforms: z.array(z.enum(['bluesky', 'mastodon'])).optional().default(['bluesky', 'mastodon']).describe('Which platforms to post to. Defaults to both.'),
    visibility: z.enum(['public', 'unlisted', 'followers_only']).optional().default('public').describe('Mastodon visibility level.'),
  },
  async ({ text, bluesky_text, mastodon_text, platforms, visibility }) => {
    const results = {};

    const bText = bluesky_text || text;
    const mText = mastodon_text || text;

    if (!bText && !mText) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Provide text, bluesky_text, or mastodon_text.' }) }],
      };
    }

    // Post to each platform in parallel
    const tasks = [];

    if (platforms.includes('bluesky') && bText) {
      tasks.push(
        postToBluesky(bText).then(r => { results.bluesky = r; })
      );
    } else if (platforms.includes('bluesky') && !bText) {
      results.bluesky = { status: 'skipped', message: 'No bluesky_text or base text provided.' };
    }

    if (platforms.includes('mastodon') && mText) {
      tasks.push(
        postToMastodon(mText, visibility).then(r => { results.mastodon = r; })
      );
    } else if (platforms.includes('mastodon') && !mText) {
      results.mastodon = { status: 'skipped', message: 'No mastodon_text or base text provided.' };
    }

    await Promise.all(tasks);

    // Log regardless of individual platform outcome
    await logMultipost({
      type: 'multipost',
      bluesky: results.bluesky || null,
      mastodon: results.mastodon || null,
      bluesky_text: bText || null,
      mastodon_text: mText || null,
    });

    const anySuccess = Object.values(results).some(r => r.status === 'success');
    const allFailed = Object.values(results).every(r => r.status === 'error');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: allFailed ? 'error' : anySuccess ? 'success' : 'partial',
          results,
        }),
      }],
    };
  }
);

// ─── Tool: shoutout ───────────────────────────────────────────────────────────

server.tool(
  'shoutout',
  'Call out a comrade positively on both platforms. Builds a shoutout post naming them by their handle on each platform. Use after real engagement — boosting comrades is mutual support.',
  {
    display_name: z.string().describe('Display name of the person being called out (e.g. "mook").'),
    bluesky_handle: z.string().optional().describe('Their Bluesky handle (e.g. "mook.bsky.social"). Include @.'),
    mastodon_handle: z.string().optional().describe('Their Mastodon handle (e.g. "@mook@possum.city"). Include @ and instance.'),
    context: z.string().describe('What they contributed — the specific idea, action, or exchange worth naming. 1-2 sentences max.'),
    platforms: z.array(z.enum(['bluesky', 'mastodon'])).optional().default(['bluesky', 'mastodon']).describe('Which platforms to post to.'),
  },
  async ({ display_name, bluesky_handle, mastodon_handle, context, platforms }) => {
    const results = {};
    const tasks = [];

    // Build per-platform shoutout text, naming the handle natively
    if (platforms.includes('bluesky')) {
      const mention = bluesky_handle || display_name;
      const bText = `Shoutout to ${mention} — ${context}`.slice(0, 300);
      tasks.push(
        postToBluesky(bText).then(r => { results.bluesky = { ...r, text: bText }; })
      );
    }

    if (platforms.includes('mastodon')) {
      const mention = mastodon_handle || display_name;
      const mText = `Shoutout to ${mention} — ${context}`.slice(0, 500);
      tasks.push(
        postToMastodon(mText, 'public').then(r => { results.mastodon = { ...r, text: mText }; })
      );
    }

    await Promise.all(tasks);

    await logMultipost({
      type: 'shoutout',
      display_name,
      bluesky_handle: bluesky_handle || null,
      mastodon_handle: mastodon_handle || null,
      context,
      bluesky: results.bluesky || null,
      mastodon: results.mastodon || null,
    });

    const anySuccess = Object.values(results).some(r => r.status === 'success');
    const allFailed = Object.values(results).every(r => r.status === 'error');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: allFailed ? 'error' : anySuccess ? 'success' : 'partial',
          results,
        }),
      }],
    };
  }
);

// ─── Tool: multireply ─────────────────────────────────────────────────────────

server.tool(
  'multireply',
  'Reply on both platforms simultaneously to continue a cross-platform conversation. Provide per-platform reply IDs.',
  {
    text: z.string().optional().describe('Base reply text used for both platforms if overrides not given.'),
    bluesky_text: z.string().max(300).optional().describe('Bluesky-specific reply (max 300 chars).'),
    mastodon_text: z.string().max(500).optional().describe('Mastodon-specific reply (max 500 chars).'),
    bluesky_uri: z.string().optional().describe('AT URI of the Bluesky post to reply to (at://...). Required if posting to Bluesky.'),
    mastodon_status_id: z.string().optional().describe('Mastodon status ID to reply to. Required if posting to Mastodon.'),
    platforms: z.array(z.enum(['bluesky', 'mastodon'])).optional().default(['bluesky', 'mastodon']),
    visibility: z.enum(['public', 'unlisted', 'followers_only']).optional().default('public'),
  },
  async ({ text, bluesky_text, mastodon_text, bluesky_uri, mastodon_status_id, platforms, visibility }) => {
    const results = {};
    const tasks = [];

    const bText = bluesky_text || text;
    const mText = mastodon_text || text;

    if (platforms.includes('bluesky') && bText && bluesky_uri) {
      if (bText.length > 300) {
        results.bluesky = { status: 'error', message: `Bluesky: exceeds 300 char limit (${bText.length} chars)` };
      } else {
        tasks.push((async () => {
          const { agent, RichText, error } = await getBlueskyAgent();
          if (error) { results.bluesky = { status: 'not_configured', message: error }; return; }
          try {
            const thread = await agent.getPostThread({ uri: bluesky_uri, depth: 0, parentHeight: 10 });
            const replyTo = thread.data.thread?.post;
            if (!replyTo) { results.bluesky = { status: 'error', message: 'Could not find post to reply to.' }; return; }

            let root = thread.data.thread;
            while (root.parent?.post) root = root.parent;

            const replyRef = {
              root: { uri: root.post.uri, cid: root.post.cid },
              parent: { uri: replyTo.uri, cid: replyTo.cid },
            };
            const record = await buildPostRecord(agent, RichText, bText);
            const result = await withRetry(() => agent.post({ ...record, reply: replyRef }));
            results.bluesky = { status: 'success', uri: result.uri, cid: result.cid, in_reply_to: bluesky_uri };
          } catch (err) {
            results.bluesky = { status: 'error', message: err.message };
          }
        })());
      }
    } else if (platforms.includes('bluesky') && !bluesky_uri) {
      results.bluesky = { status: 'skipped', message: 'bluesky_uri not provided.' };
    }

    if (platforms.includes('mastodon') && mText && mastodon_status_id) {
      if (mText.length > 500) {
        results.mastodon = { status: 'error', message: `Mastodon: exceeds 500 char limit (${mText.length} chars)` };
      } else {
        tasks.push((async () => {
          try {
            const status = await masto('/statuses', {
              method: 'POST',
              body: JSON.stringify({ status: mText, in_reply_to_id: mastodon_status_id, visibility }),
            });
            results.mastodon = { status: 'success', id: status.id, url: status.url, in_reply_to: mastodon_status_id };
          } catch (err) {
            results.mastodon = { status: 'error', message: err.message };
          }
        })());
      }
    } else if (platforms.includes('mastodon') && !mastodon_status_id) {
      results.mastodon = { status: 'skipped', message: 'mastodon_status_id not provided.' };
    }

    await Promise.all(tasks);

    await logMultipost({
      type: 'multireply',
      bluesky: results.bluesky || null,
      mastodon: results.mastodon || null,
    });

    const anySuccess = Object.values(results).some(r => r.status === 'success');
    const allFailed = Object.values(results).every(r => r.status === 'error');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: allFailed ? 'error' : anySuccess ? 'success' : 'partial',
          results,
        }),
      }],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
