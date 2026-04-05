#!/usr/bin/env node
/**
 * Cognee Knowledge Graph MCP Server for Comrade Claw
 *
 * Lightweight Node.js MCP server that proxies to Cognee's HTTP API.
 * Cognee runs as a persistent Python service on localhost:8001.
 * This server starts instantly (no Python init delay).
 *
 * Tools: cognify, search, prune
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const COGNEE_URL = process.env.COGNEE_URL || 'http://127.0.0.1:8001';

async function cogneeRequest(path, body = {}) {
  const res = await fetch(`${COGNEE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000), // 5 min timeout for cognify
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ─── MCP Server ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-memory',
  version: '1.0.0',
  description: 'Cognee knowledge graph for Comrade Claw'
});

// ─── Tool: cognify ──────────────────────────────────────────────────────────

server.tool(
  'cognify',
  'Build knowledge graph from text. Extracts entities, relationships, and embeddings via Ollama.',
  { text: z.string().describe('Text to add to the knowledge graph and cognify.') },
  async ({ text }) => {
    try {
      // Check if Cognee service is running
      const health = await fetch(`${COGNEE_URL}/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json()).catch(() => null);
      if (!health) {
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: 'Cognee HTTP service not running. Start it with: cd E:/AI/cognee-mcp && .venv/Scripts/python.exe http-api.py' }) }] };
      }

      const result = await cogneeRequest('/cognify', { text });
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', ...result }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: search ───────────────────────────────────────────────────────────

server.tool(
  'search',
  'Search the knowledge graph. Returns semantically related entities and relationships.',
  {
    query: z.string().describe('Search query.'),
    query_type: z.string().optional().default('GRAPH_COMPLETION').describe('Search type: GRAPH_COMPLETION (default), SIMILARITY, or HYBRID.')
  },
  async ({ query, query_type }) => {
    try {
      const result = await cogneeRequest('/search', { query, query_type });
      const formatted = result.results
        ? (typeof result.results === 'string' ? result.results : JSON.stringify(result.results, null, 2))
        : 'No results found.';
      return { content: [{ type: 'text', text: formatted }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Tool: prune ────────────────────────────────────────────────────────────

server.tool(
  'prune',
  'Reset the knowledge graph. Clears all stored data. Use with caution.',
  {},
  async () => {
    try {
      const result = await cogneeRequest('/prune');
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'success', message: 'Knowledge graph pruned.' }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }) }] };
    }
  }
);

// ─── Start Server ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
