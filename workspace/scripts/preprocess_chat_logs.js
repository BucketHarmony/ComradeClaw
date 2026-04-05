#!/usr/bin/env node
/**
 * preprocess_chat_logs.js
 *
 * Strips boilerplate from old-format chat logs before Cognee ingestion.
 *
 * Old format (2026-03-11 through 2026-03-20):
 *   Each API turn is wrapped in:
 *     ## Full API Request (TIMESTAMP)
 *     ### System Prompt         ← strips entire fenced block (repeats every turn)
 *     ### Conversation History  ← strips JSON array (grows every turn)
 *     ### User Message          ← KEEP
 *     ### Assistant Response    ← KEEP
 *
 * New format (2026-04-xx):
 *   [HH:MM] Operator: ...
 *   [HH:MM] Claw: ...
 *   Already compact — pass through unchanged.
 *
 * Output: workspace/logs/chat/preprocessed/YYYY-MM-DD.md
 *
 * Usage:
 *   node workspace/scripts/preprocess_chat_logs.js [file ...]
 *   node workspace/scripts/preprocess_chat_logs.js          # processes all files
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');
const chatDir = join(projectRoot, 'workspace', 'logs', 'chat');
const outDir = join(chatDir, 'preprocessed');

mkdirSync(outDir, { recursive: true });

function isOldFormat(content) {
  return content.includes('## Full API Request');
}

/**
 * Strip old-format boilerplate.
 * Removes:
 *   - ### System Prompt\n\n```\n...\n```
 *   - ### Conversation History (N messages in context)\n\n```json\n...\n```
 *
 * Rewrites each ## Full API Request block to just the timestamp header
 * plus the User Message and Assistant Response sections.
 */
function preprocessOldFormat(content) {
  const lines = content.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // System Prompt section: strip until closing ```
    if (line.startsWith('### System Prompt')) {
      // skip until we find the closing ``` after the opening ```
      i++;
      // skip blank lines before the fence
      while (i < lines.length && lines[i].trim() === '') i++;
      // skip opening fence
      if (i < lines.length && lines[i].trim().startsWith('```')) i++;
      // skip until closing fence
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      // skip closing fence
      if (i < lines.length) i++;
      continue;
    }

    // Conversation History section: strip until closing ```
    if (line.startsWith('### Conversation History')) {
      i++;
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i < lines.length && lines[i].trim().startsWith('```')) i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) i++;
      if (i < lines.length) i++;
      continue;
    }

    out.push(line);
    i++;
  }

  // Collapse runs of 3+ blank lines down to 2
  const collapsed = [];
  let blankRun = 0;
  for (const l of out) {
    if (l.trim() === '') {
      blankRun++;
      if (blankRun <= 2) collapsed.push(l);
    } else {
      blankRun = 0;
      collapsed.push(l);
    }
  }

  return collapsed.join('\n');
}

function processFile(srcPath) {
  const raw = readFileSync(srcPath, 'utf8');
  const name = basename(srcPath);
  const outPath = join(outDir, name);

  if (!isOldFormat(raw)) {
    // New format — pass through unchanged
    writeFileSync(outPath, raw, 'utf8');
    const lines = raw.split('\n').length;
    console.log(`${name}: new format, ${lines} lines → copied unchanged`);
    return;
  }

  const processed = preprocessOldFormat(raw);
  writeFileSync(outPath, processed, 'utf8');

  const inLines = raw.split('\n').length;
  const outLines = processed.split('\n').length;
  const reduction = (((inLines - outLines) / inLines) * 100).toFixed(1);
  console.log(`${name}: ${inLines} → ${outLines} lines (${reduction}% stripped)`);
}

// Determine which files to process
let targets;
const cliArgs = process.argv.slice(2);
if (cliArgs.length > 0) {
  targets = cliArgs;
} else {
  targets = readdirSync(chatDir)
    .filter(f => f.endsWith('.md') && f.match(/^\d{4}-\d{2}-\d{2}/))
    .map(f => join(chatDir, f));
}

console.log(`Processing ${targets.length} file(s) → ${outDir}\n`);
let totalIn = 0;
let totalOut = 0;

for (const t of targets) {
  const raw = readFileSync(t, 'utf8');
  totalIn += raw.split('\n').length;
  processFile(t);
  const outPath = join(outDir, basename(t));
  const processed = readFileSync(outPath, 'utf8');
  totalOut += processed.split('\n').length;
}

console.log(`\nTotal: ${totalIn.toLocaleString()} → ${totalOut.toLocaleString()} lines`);
const pct = (((totalIn - totalOut) / totalIn) * 100).toFixed(1);
console.log(`Overall reduction: ${pct}%`);
