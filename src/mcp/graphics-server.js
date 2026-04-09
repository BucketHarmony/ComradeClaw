#!/usr/bin/env node
/**
 * Graphics MCP Server for Comrade Claw
 *
 * Executes D3 drawing code in a sandboxed Node child process with jsdom.
 * Claw writes the D3 code; this server runs it, self-corrects up to 3x,
 * and saves the resulting SVG to workspace/graphics/.
 *
 * Tools: generate_graphic
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(PROJECT_ROOT, 'workspace');
const GRAPHICS_PATH = path.join(WORKSPACE_PATH, 'graphics');

// ─── D3 Execution Preamble ───────────────────────────────────────────────────
//
// Claw's drawing code runs inside this wrapper. Available variables:
//   d3       — the d3 module (all of d3-*)
//   document — jsdom document
//   window   — jsdom window
//   svg      — d3 selection of <svg> on document.body, 800×600 by default
//              (can override width/height before using it)
//
// The code MUST NOT call process.exit() or write to stdout.
// The wrapper extracts document.body.innerHTML as the SVG output.

function buildScript(userCode) {
  return `
import { JSDOM } from 'jsdom';
import * as d3 from 'd3';

const dom = new JSDOM('<!DOCTYPE html><body></body>');
const { document, window } = dom.window;

// Default dimensions — drawing code may redefine before appending to svg
let width = 800;
let height = 600;

const body = d3.select(document.body);
const svg = body.append('svg')
  .attr('xmlns', 'http://www.w3.org/2000/svg')
  .attr('width', width)
  .attr('height', height);

// ─── DRAWING CODE ───────────────────────────────────────────────────────────
${userCode}
// ─── END DRAWING CODE ───────────────────────────────────────────────────────

// Update svg dimensions if the drawing code changed width/height
svg.attr('width', width).attr('height', height);

process.stdout.write(document.body.innerHTML);
`;
}

// ─── Execute D3 code in a child process ──────────────────────────────────────

async function runD3(code) {
  // Write temp file inside the project so ESM can resolve node_modules
  const tmpFile = path.join(PROJECT_ROOT, `.claw-graphic-${crypto.randomBytes(6).toString('hex')}.mjs`);

  const script = buildScript(code);
  await fs.writeFile(tmpFile, script, 'utf8');

  try {
    const result = spawnSync('node', [tmpFile], {
      cwd: PROJECT_ROOT,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      encoding: 'utf8',
    });

    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return { ok: false, error: result.stderr || `exit code ${result.status}` };
    }
    const svg = result.stdout.trim();
    if (!svg.startsWith('<svg')) {
      return { ok: false, error: `Output does not look like SVG: ${svg.slice(0, 200)}` };
    }
    return { ok: true, svg };
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claw-graphics',
  version: '1.0.0',
});

server.tool(
  'generate_graphic',
  {
    filename: z.string().describe('Output filename without extension (e.g. "bpp-breakfast-poster"). Saved to workspace/graphics/<filename>.svg'),
    d3_code: z.string().describe('D3 drawing code. Uses: d3, document, window, svg (800×600 <svg> selection). Set width/height variables before drawing to resize. Do NOT write to stdout or call process.exit.'),
    description: z.string().optional().describe('Human-readable description of what this graphic is for (logged with the file)'),
  },
  async ({ filename, d3_code, description }) => {
    // Ensure graphics dir exists
    await fs.mkdir(GRAPHICS_PATH, { recursive: true });

    const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
    const outPath = path.join(GRAPHICS_PATH, `${safeName}.svg`);

    let lastError = null;
    let currentCode = d3_code;

    // Self-correction loop — up to 3 attempts
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await runD3(currentCode);

      if (result.ok) {
        await fs.writeFile(outPath, result.svg, 'utf8');
        const meta = {
          filename: `${safeName}.svg`,
          path: outPath,
          description: description || null,
          created: new Date().toISOString(),
          attempts: attempt,
        };
        const metaPath = path.join(GRAPHICS_PATH, `${safeName}.json`);
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                path: outPath,
                filename: `${safeName}.svg`,
                attempts: attempt,
                size_bytes: Buffer.byteLength(result.svg),
                message: `SVG saved to workspace/graphics/${safeName}.svg`,
              }),
            },
          ],
        };
      }

      lastError = result.error;

      // Return error on last attempt so Claw can revise the code externally
      if (attempt === 3) break;

      // Pass error back — Claw must call again with fixed code
      // (The tool doesn't auto-revise; Claw sees the error and retries)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'error',
              attempt,
              error: lastError,
              message: `D3 execution failed on attempt ${attempt}. Fix the code and call generate_graphic again.`,
              hint: 'Common fixes: check d3 API calls match d3 v7, ensure no browser-only APIs (canvas, fetch), avoid process.exit()',
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'failed',
            attempts: 3,
            last_error: lastError,
            message: 'All 3 attempts failed. Review the error and rewrite the D3 code from scratch.',
          }),
        },
      ],
    };
  }
);

// ─── List saved graphics ──────────────────────────────────────────────────────

server.tool(
  'list_graphics',
  {},
  async () => {
    await fs.mkdir(GRAPHICS_PATH, { recursive: true });
    const files = await fs.readdir(GRAPHICS_PATH);
    const svgs = files.filter(f => f.endsWith('.svg'));

    const items = await Promise.all(
      svgs.map(async f => {
        const metaFile = f.replace('.svg', '.json');
        try {
          const meta = JSON.parse(await fs.readFile(path.join(GRAPHICS_PATH, metaFile), 'utf8'));
          return meta;
        } catch {
          const stat = await fs.stat(path.join(GRAPHICS_PATH, f)).catch(() => null);
          return { filename: f, path: path.join(GRAPHICS_PATH, f), created: stat?.mtime };
        }
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ status: 'ok', count: items.length, graphics: items }),
        },
      ],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
