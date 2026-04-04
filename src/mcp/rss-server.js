#!/usr/bin/env node
/**
 * RSS Feed MCP Server for Comrade Claw
 *
 * Exposes RSS feed tools via the Model Context Protocol (stdio transport).
 * Tools: fetch_feed, subscribe_feed, unsubscribe_feed, list_feeds,
 *        read_new_items (check all subscribed feeds for unseen articles)
 *
 * Subscriptions stored in: workspace/feeds/subscribed.json
 * Last-seen state stored in: workspace/feeds/last_seen.json
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import Parser from 'rss-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');
const FEEDS_DIR = path.join(WORKSPACE_PATH, 'feeds');
const SUBS_FILE = path.join(FEEDS_DIR, 'subscribed.json');
const SEEN_FILE = path.join(FEEDS_DIR, 'last_seen.json');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'ComradeClaw/2.0 (RSS reader)' },
  customFields: { item: [['dc:creator', 'author']] }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir() {
  await fs.mkdir(FEEDS_DIR, { recursive: true });
}

async function loadSubs() {
  try {
    const data = await fs.readFile(SUBS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveSubs(subs) {
  await ensureDir();
  await fs.writeFile(SUBS_FILE, JSON.stringify(subs, null, 2));
}

async function loadSeen() {
  try {
    const data = await fs.readFile(SEEN_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveSeen(seen) {
  await ensureDir();
  await fs.writeFile(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function normalizeDate(item) {
  return item.isoDate || item.pubDate || null;
}

function itemId(item) {
  // Stable identifier for an article
  return item.guid || item.link || item.title || '';
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-feeds',
  version: '1.0.0',
  description: 'RSS feed ingestion for Comrade Claw — labor news, co-ops, theory, mutual aid'
});

// ─── Tool: fetch_feed ─────────────────────────────────────────────────────────

server.tool(
  'fetch_feed',
  'Fetch and parse any RSS/Atom feed URL. Returns recent articles with title, link, date, and snippet.',
  {
    url: z.string().describe('RSS or Atom feed URL'),
    limit: z.coerce.number().optional().default(10).describe('Max articles to return (1-50, default 10)')
  },
  async ({ url, limit }) => {
    const fetchLimit = Math.min(Math.max(1, limit ?? 10), 50);
    try {
      const feed = await parser.parseURL(url);
      const articles = (feed.items || []).slice(0, fetchLimit).map(item => ({
        id: itemId(item),
        title: item.title || '(no title)',
        link: item.link || '',
        pubDate: normalizeDate(item),
        author: item.author || item.creator || '',
        snippet: (item.contentSnippet || item.summary || '').substring(0, 300)
      }));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            feedTitle: feed.title || '',
            feedLink: feed.link || url,
            count: articles.length,
            articles
          })
        }]
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: err.message })
        }]
      };
    }
  }
);

// ─── Tool: subscribe_feed ─────────────────────────────────────────────────────

server.tool(
  'subscribe_feed',
  'Subscribe to an RSS feed for regular new-item checking. Validates the feed is reachable before saving.',
  {
    url: z.string().describe('RSS or Atom feed URL'),
    name: z.string().describe('Human-readable name (e.g. "Jacobin", "GEO Newsletter")'),
    category: z.string().optional().default('general').describe('Category: labor | co-ops | mutual-aid | theory | local | tech | general')
  },
  async ({ url, name, category }) => {
    // Validate feed is accessible
    let feedTitle = '';
    try {
      const feed = await parser.parseURL(url);
      feedTitle = feed.title || name;
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: `Feed not accessible: ${err.message}` })
        }]
      };
    }

    const subs = await loadSubs();

    // Prevent duplicate subscriptions
    if (subs.some(s => s.url === url)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: `Already subscribed to ${url}` })
        }]
      };
    }

    subs.push({
      url,
      name,
      feedTitle,
      category: category || 'general',
      subscribed_at: new Date().toISOString(),
      disabled: false
    });

    await saveSubs(subs);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          message: `Subscribed to "${name}" (${feedTitle})`,
          totalSubscriptions: subs.length
        })
      }]
    };
  }
);

// ─── Tool: unsubscribe_feed ───────────────────────────────────────────────────

server.tool(
  'unsubscribe_feed',
  'Remove a feed from subscriptions by URL.',
  {
    url: z.string().describe('Feed URL to unsubscribe from')
  },
  async ({ url }) => {
    const subs = await loadSubs();
    const before = subs.length;
    const updated = subs.filter(s => s.url !== url);

    if (updated.length === before) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: `No subscription found for ${url}` })
        }]
      };
    }

    await saveSubs(updated);

    // Clean up seen state for removed feed
    const seen = await loadSeen();
    delete seen[url];
    await saveSeen(seen);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'success', message: `Unsubscribed from ${url}`, totalSubscriptions: updated.length })
      }]
    };
  }
);

// ─── Tool: list_feeds ─────────────────────────────────────────────────────────

server.tool(
  'list_feeds',
  'List all subscribed RSS feeds, optionally filtered by category.',
  {
    category: z.string().optional().describe('Filter by category (e.g. "labor", "co-ops")')
  },
  async ({ category }) => {
    const subs = await loadSubs();
    const filtered = category
      ? subs.filter(s => s.category === category)
      : subs;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          count: filtered.length,
          feeds: filtered.map(s => ({
            name: s.name,
            url: s.url,
            category: s.category,
            disabled: s.disabled || false
          }))
        })
      }]
    };
  }
);

// ─── Tool: read_new_items ─────────────────────────────────────────────────────

server.tool(
  'read_new_items',
  'Check all subscribed feeds for articles not yet seen. Returns new items across all feeds, sorted by date. Updates last-seen state so duplicates are not returned next call.',
  {
    category: z.string().optional().describe('Only check feeds in this category (omit for all)'),
    limit_per_feed: z.coerce.number().optional().default(5).describe('Max new items per feed (default 5)')
  },
  async ({ category, limit_per_feed }) => {
    const perFeed = Math.min(Math.max(1, limit_per_feed ?? 5), 20);
    const subs = await loadSubs();
    const seen = await loadSeen();

    const active = subs.filter(s => !s.disabled && (!category || s.category === category));

    if (active.length === 0) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', count: 0, items: [], message: 'No active subscriptions' })
        }]
      };
    }

    const allNew = [];
    const errors = [];
    const updatedSeen = { ...seen };

    for (const sub of active) {
      try {
        const feed = await parser.parseURL(sub.url);
        const items = feed.items || [];

        const seenIds = new Set(seen[sub.url] || []);
        const newItems = [];

        for (const item of items) {
          const id = itemId(item);
          if (id && seenIds.has(id)) continue;
          newItems.push({
            feedName: sub.name,
            feedCategory: sub.category,
            id,
            title: item.title || '(no title)',
            link: item.link || '',
            pubDate: normalizeDate(item),
            author: item.author || item.creator || '',
            snippet: (item.contentSnippet || item.summary || '').substring(0, 400)
          });
          if (newItems.length >= perFeed) break;
        }

        // Update seen: store IDs of all current items (not just new ones)
        updatedSeen[sub.url] = items.slice(0, 50).map(itemId).filter(Boolean);

        allNew.push(...newItems);
      } catch (err) {
        errors.push({ feed: sub.name, url: sub.url, error: err.message });
      }
    }

    await saveSeen(updatedSeen);

    // Sort by pubDate descending (most recent first), nulls last
    allNew.sort((a, b) => {
      if (!a.pubDate && !b.pubDate) return 0;
      if (!a.pubDate) return 1;
      if (!b.pubDate) return -1;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'success',
          count: allNew.length,
          feedsChecked: active.length,
          errors: errors.length > 0 ? errors : undefined,
          items: allNew
        })
      }]
    };
  }
);

// ─── Start Server ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
