#!/usr/bin/env node
/**
 * Write.as MCP Server for Comrade Claw
 *
 * Autonomous long-form publishing via the Write.as REST API.
 * No browser automation needed — full write API available with API token.
 *
 * Tools: writeas_publish, writeas_update, writeas_list, writeas_delete
 *
 * Requires: WRITEAS_TOKEN in .env
 * Optional: WRITEAS_COLLECTION (blog alias, e.g. "comrade-claw") for collection posts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
config({ path: path.join(__dirname, '..', '..', '.env') });

const API_BASE = 'https://write.as/api';
const TOKEN = process.env.WRITEAS_TOKEN;
const DEFAULT_COLLECTION = process.env.WRITEAS_COLLECTION || null;

function authHeaders() {
  if (!TOKEN) throw new Error('WRITEAS_TOKEN not set in .env');
  return {
    'Authorization': `Token ${TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function apiRequest(method, endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Write.as returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = data?.error_msg || data?.message || JSON.stringify(data);
    throw new Error(`Write.as API error (HTTP ${res.status}): ${msg}`);
  }

  return data;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-writeas',
  version: '1.0.0',
  description: 'Autonomous long-form publishing on Write.as via REST API.',
});

// ── writeas_publish ──────────────────────────────────────────────────────────

server.tool(
  'writeas_publish',
  'Publish a new post to Write.as. Optionally targets a collection (blog). Returns the post URL.',
  {
    title: z.string().describe('Post title'),
    body: z.string().describe('Post body in Markdown'),
    collection: z.string().optional().describe(
      'Collection alias to publish under (e.g. "comrade-claw"). Omit for anonymous post. Falls back to WRITEAS_COLLECTION env var.'
    ),
    font: z.enum(['norm', 'sans', 'mono', 'wrap', 'code']).default('norm').describe(
      'Display font: norm (serif), sans, mono, wrap (word-wrap), code'
    ),
    lang: z.string().default('en').describe('ISO 639-1 language code'),
  },
  async ({ title, body, collection, font, lang }) => {
    try {
      const target = collection || DEFAULT_COLLECTION;
      const payload = { title, body, font, lang };

      let data;
      if (target) {
        data = await apiRequest('POST', `/collections/${target}/posts`, payload);
      } else {
        data = await apiRequest('POST', '/posts', payload);
      }

      const post = data.data;
      const url = target
        ? `https://write.as/${target}/${post.slug || post.id}`
        : `https://write.as/${post.id}`;

      // Regenerate essay index in background (non-blocking, non-fatal)
      regenerateEssayIndex(target).catch(() => {});

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'published',
        id: post.id,
        slug: post.slug || null,
        token: post.token || null,   // save this to update/delete later
        url,
        title: post.title,
        collection: target || null,
        published_at: post.created,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── writeas_update ───────────────────────────────────────────────────────────

server.tool(
  'writeas_update',
  'Update the title or body of an existing Write.as post by ID.',
  {
    post_id: z.string().describe('Post ID returned when the post was created'),
    token: z.string().describe('Post edit token returned when the post was created'),
    title: z.string().optional().describe('New title (omit to keep existing)'),
    body: z.string().optional().describe('New body in Markdown (omit to keep existing)'),
  },
  async ({ post_id, token, title, body }) => {
    try {
      const payload = {};
      if (title !== undefined) payload.title = title;
      if (body !== undefined) payload.body = body;
      payload.token = token;

      const data = await apiRequest('POST', `/posts/${post_id}`, payload);
      const post = data.data;

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'updated',
        id: post.id,
        updated_at: post.updated,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── writeas_list ─────────────────────────────────────────────────────────────

server.tool(
  'writeas_list',
  'List your published posts. If a collection alias is given, lists posts in that collection.',
  {
    collection: z.string().optional().describe('Collection alias (omit for all posts on your account)'),
    limit: z.number().min(1).max(50).default(10),
  },
  async ({ collection, limit }) => {
    try {
      const target = collection || DEFAULT_COLLECTION;
      let data;
      if (target) {
        data = await apiRequest('GET', `/collections/${target}/posts`);
      } else {
        data = await apiRequest('GET', '/me/posts');
      }

      const posts = (data.data || []).slice(0, limit).map(p => ({
        id: p.id,
        slug: p.slug || null,
        title: p.title || '(untitled)',
        url: target
          ? `https://write.as/${target}/${p.slug || p.id}`
          : `https://write.as/${p.id}`,
        created: p.created,
        updated: p.updated || null,
        views: p.views || 0,
      }));

      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ok',
        collection: target || 'account',
        post_count: posts.length,
        posts,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ── writeas_delete ───────────────────────────────────────────────────────────

server.tool(
  'writeas_delete',
  'Delete a Write.as post by ID. Requires the post edit token.',
  {
    post_id: z.string().describe('Post ID'),
    token: z.string().describe('Post edit token'),
  },
  async ({ post_id, token }) => {
    try {
      await apiRequest('DELETE', `/posts/${post_id}?token=${encodeURIComponent(token)}`);
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'deleted',
        post_id,
      }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Essay Index ─────────────────────────────────────────────────────────────

const ESSAYS_INDEX_PATH = path.join(__dirname, '..', '..', 'obsidian', 'ComradeClaw', 'Research', 'Essays.md');

/**
 * Extract the first 1–2 sentences from a markdown body (strip headers/bullets).
 */
function extractExcerpt(body = '') {
  const cleaned = body
    .replace(/^#{1,6}\s+.+$/gm, '')   // strip headings
    .replace(/^[-*+]\s+/gm, '')        // strip list bullets
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links
    .replace(/\*+([^*]+)\*+/g, '$1')   // strip bold/italic
    .trim();
  // Take up to first 2 sentence-ending punctuation marks
  const match = cleaned.match(/^(.+?[.!?])(\s+.+?[.!?])?/s);
  if (!match) return cleaned.slice(0, 120).trim();
  return (match[1] + (match[2] || '')).trim().slice(0, 200);
}

/**
 * Regenerate obsidian/ComradeClaw/Research/Essays.md from the collection post list.
 * Called after every successful publish. Non-fatal on error.
 */
async function regenerateEssayIndex(collection) {
  if (!collection) return;
  try {
    const data = await apiRequest('GET', `/collections/${collection}/posts`);
    const posts = (data.data || []).map(p => ({
      title: p.title || '(untitled)',
      date: (p.created || '').slice(0, 10),
      url: `https://write.as/${collection}/${p.slug || p.id}`,
      excerpt: extractExcerpt(p.body || ''),
    })).sort((a, b) => b.date.localeCompare(a.date));

    const lines = [
      '---',
      'tags: [research, essays, publishing]',
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      'auto-generated: true',
      '---',
      '',
      '# Essays',
      '',
      '*Auto-generated from Write.as collection. Updated after each publish.*',
      '',
      '---',
      '',
    ];

    for (const p of posts) {
      lines.push(`## [${p.title}](${p.url})`);
      lines.push(`*${p.date}*`);
      lines.push('');
      if (p.excerpt) {
        lines.push(p.excerpt);
        lines.push('');
      }
      lines.push(`→ [Read full essay](${p.url})`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    if (posts.length === 0) {
      lines.push('*No essays published yet.*');
      lines.push('');
    }

    const { writeFile, mkdir } = await import('fs/promises');
    const dir = path.dirname(ESSAYS_INDEX_PATH);
    await mkdir(dir, { recursive: true });
    await writeFile(ESSAYS_INDEX_PATH, lines.join('\n'), 'utf8');
  } catch {
    // Non-fatal — publish already succeeded
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
