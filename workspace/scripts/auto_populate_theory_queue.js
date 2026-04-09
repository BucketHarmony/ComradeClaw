#!/usr/bin/env node
/**
 * auto_populate_theory_queue.js
 *
 * Scans obsidian/ComradeClaw/Theory/*.md for theory notes with no entry
 * in workspace/theory_queue.md, then appends [pending] entries with excerpts.
 *
 * Works at two levels:
 *   1. File level (H1 title) — add if the whole note is unqueued
 *   2. H2 section level — add substantive H2 sections not yet queued
 *      (skips meta sections: Status, Relationship, Theory Drift Check, etc.)
 *
 * Usage: node workspace/scripts/auto_populate_theory_queue.js
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const THEORY_DIR = 'obsidian/ComradeClaw/Theory';
const QUEUE_FILE = 'workspace/theory_queue.md';

// Reference/meta files — not independently distributable
const SKIP_FILES = new Set(['Core Positions.md']);

// H2 section names that are structural/meta — not distributable posts
const SKIP_SECTIONS = new Set([
  'status', 'relationship to other theory notes', 'see also',
  'theory drift check', 'lessons for cooperators', 'what he built',
  'his analysis', 'what the state did', 'what survived',
  'on dual power', 'on state response', 'on organization',
  'on internationalism', 'on internal dangers',
  'permanent revolution', "workers' councils / soviets (dual power)",
  'bureaucratic degeneration', 'mass line ("from the masses, to the masses")',
  'guerrilla warfare / base areas', 'contradictions analysis',
  'cultural revolution (catastrophic failure)',
  'mutual aid (with kropotkin)', 'soviet disillusionment',
  'propaganda of the deed (evolution)', 'what killed her work',
]);

function extractH1(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function extractH2Sections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = null;
  let inFrontmatter = false;
  let frontmatterDone = false;
  let pastH1 = false;

  for (const line of lines) {
    if (!frontmatterDone) {
      if (line.trim() === '---') {
        if (!inFrontmatter) { inFrontmatter = true; continue; }
        else { frontmatterDone = true; continue; }
      }
      if (inFrontmatter) continue;
    }
    if (line.startsWith('# ') && !pastH1) { pastH1 = true; continue; }
    if (!pastH1) continue;
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { title: line.replace(/^##\s+/, '').trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections;
}

function extractExcerptFromLines(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('*') || t.startsWith('>') ||
        t.startsWith('-') || t.startsWith('---') || t.length < 25) continue;
    // Skip bold-only lines (** ... **)
    if (/^\*\*[^*]+\*\*$/.test(t)) continue;
    const sentEnd = t.search(/[.!?]/);
    if (sentEnd > 15) return t.substring(0, sentEnd + 1);
    if (t.length > 40) return t.length > 120 ? t.substring(0, 120) + '...' : t;
  }
  return null;
}

function wordsInWindow(words, qLower, window = 200) {
  if (words.length === 0) return false;
  const positions = words.map(w => {
    const ps = [];
    let pos = 0;
    while ((pos = qLower.indexOf(w, pos)) !== -1) { ps.push(pos); pos++; }
    return ps;
  });
  if (positions.some(p => p.length === 0)) return false;
  for (const start of positions[0]) {
    if (positions.every(pList => pList.some(p => p >= start && p <= start + window))) {
      return true;
    }
  }
  return false;
}

function inQueue(text, queueContent) {
  const qLower = queueContent.toLowerCase();

  // Strategy 1: direct substring
  if (qLower.includes(text.toLowerCase())) return true;

  // Strategy 2: title before subtitle (strip ": ..." suffix)
  const mainTitle = text.replace(/:\s+.+$/, '').toLowerCase();
  if (mainTitle !== text.toLowerCase() && qLower.includes(mainTitle)) return true;

  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
  const words = normalized.split(/\s+/).filter(w => w.length >= 4);

  // Strategy 3: all significant words in window
  if (wordsInWindow(words, qLower)) return true;

  // Strategy 4: first 3 significant words only (handles subtitle false-negatives)
  if (words.length > 3 && wordsInWindow(words.slice(0, 3), qLower)) return true;

  return false;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const queueContent = readFileSync(QUEUE_FILE, 'utf-8');
const files = readdirSync(THEORY_DIR)
  .filter(f => f.endsWith('.md') && !SKIP_FILES.has(f))
  .sort();

const newEntries = [];

for (const file of files) {
  const content = readFileSync(join(THEORY_DIR, file), 'utf-8');
  const h1 = extractH1(content);
  if (!h1) continue;

  const h1InQueue = inQueue(h1, queueContent);
  console.log(`\n── ${file}`);
  console.log(`   H1: "${h1}" — ${h1InQueue ? '✓ in queue' : '✗ NOT in queue'}`);

  if (!h1InQueue) {
    // Queue the whole note
    const sections = extractH2Sections(content);
    let excerpt = null;

    // Try to find excerpt from first non-meta section
    for (const sec of sections) {
      if (SKIP_SECTIONS.has(sec.title.toLowerCase())) continue;
      excerpt = extractExcerptFromLines(sec.lines);
      if (excerpt) break;
    }

    // Fallback: extract from content directly after H1
    if (!excerpt) {
      const afterH1 = content.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#[^\n]+\n/m, '');
      excerpt = extractExcerptFromLines(afterH1.split('\n'));
    }

    if (excerpt) {
      newEntries.push(`- **[candidate]** **${h1}** — ${excerpt}`);
      console.log(`   → Adding file-level entry`);
      console.log(`   → Excerpt: ${excerpt.substring(0, 80)}...`);
    } else {
      console.log(`   ⚠ Could not extract excerpt`);
    }
    continue;
  }

  // File is in queue — check H2 sections individually
  const sections = extractH2Sections(content);
  for (const sec of sections) {
    const secTitleLower = sec.title.toLowerCase();
    if (SKIP_SECTIONS.has(secTitleLower)) {
      console.log(`   Section "${sec.title}" — skipped (meta)`);
      continue;
    }

    const secInQueue = inQueue(sec.title, queueContent);
    if (secInQueue) {
      console.log(`   Section "${sec.title}" — ✓ in queue`);
      continue;
    }

    const excerpt = extractExcerptFromLines(sec.lines);
    if (excerpt) {
      newEntries.push(`- **[candidate]** **${sec.title}** — ${excerpt}`);
      console.log(`   Section "${sec.title}" — ✗ adding`);
      console.log(`     Excerpt: ${excerpt.substring(0, 70)}...`);
    } else {
      console.log(`   Section "${sec.title}" — ✗ no excerpt found`);
    }
  }
}

console.log(`\n${'─'.repeat(60)}`);
if (newEntries.length > 0) {
  const date = new Date().toISOString().split('T')[0];
  const block = `\n<!-- auto-populated ${date} -->\n` + newEntries.join('\n') + '\n';
  writeFileSync(QUEUE_FILE, queueContent.trimEnd() + block);
  console.log(`Added ${newEntries.length} new [candidate] entr${newEntries.length === 1 ? 'y' : 'ies'} to theory_queue.md`);
  newEntries.forEach(e => console.log(' ', e.substring(0, 90) + (e.length > 90 ? '...' : '')));
} else {
  console.log('All theory vault files and sections already represented in theory_queue.md');
}

// ── Promote candidates ────────────────────────────────────────────────────────

console.log(`\n── Promoting [candidate] items`);
const updatedQueue = readFileSync(QUEUE_FILE, 'utf-8');
const promoted = promoteCandidates(updatedQueue);
if (promoted.count > 0) {
  writeFileSync(QUEUE_FILE, promoted.content);
  console.log(`Promoted ${promoted.count} candidate${promoted.count !== 1 ? 's' : ''} to [pending]: ${promoted.titles.join(', ')}`);
} else {
  console.log('No candidates to promote (fewer than 3 candidates, or none found).');
}

/**
 * Promote top-scoring [candidate] items to [pending].
 * Scores by keyword overlap with Characters.md "Key exchange" / "Why they matter" text.
 * Promotes only if ≥3 candidates exist (below that, manual review is fast enough).
 * Returns { content, count, titles }.
 */
function promoteCandidates(content, maxPromote = 2) {
  const CHARS_FILE = 'obsidian/ComradeClaw/Characters.md';
  let charsText = '';
  try { charsText = readFileSync(CHARS_FILE, 'utf-8'); } catch { /* non-fatal */ }

  // Extract keywords from Characters.md engagement lines
  const STOP = new Set(['their', 'which', 'about', 'after', 'where', 'there', 'these', 'those',
    'being', 'would', 'could', 'should', 'comrade', 'status', 'matter', 'first', 'appeared']);
  const relevant = charsText.split('\n')
    .filter(l => /Key exchange|Why they matter|key exchange|Status/i.test(l))
    .join(' ');
  const kwSet = new Set(
    [...relevant.matchAll(/\b([a-z]{5,})\b/gi)]
      .map(m => m[1].toLowerCase())
      .filter(w => !STOP.has(w))
  );

  const candidateMatches = [...content.matchAll(/^- \*\*\[candidate\]\*\* \*\*(.+?)\*\* — (.+)$/gm)];
  if (candidateMatches.length < 3) return { content, count: 0, titles: [] };

  const scored = candidateMatches.map(m => {
    const title = m[1], desc = m[2];
    const text = (title + ' ' + desc).toLowerCase();
    const words = text.match(/\b[a-z]{4,}\b/g) || [];
    const score = words.filter(w => kwSet.has(w)).length;
    return { fullMatch: m[0], title, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const toPromote = scored.slice(0, maxPromote);

  const date = new Date().toISOString().split('T')[0];
  let updated = content;
  const promoted = [];
  for (const item of toPromote) {
    const replacement = item.fullMatch
      .replace('**[candidate]**', '**[pending]**')
      + ` *(promoted ${date}, score=${item.score})*`;
    updated = updated.replace(item.fullMatch, replacement);
    promoted.push(item.title);
    console.log(`  → Promoted: "${item.title}" (score=${item.score})`);
  }

  return { content: updated, count: promoted.length, titles: promoted };
}
