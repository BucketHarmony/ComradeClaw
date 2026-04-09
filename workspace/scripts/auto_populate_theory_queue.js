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
 * Scan workspace/logs/posts/*.json for theory-related posts and return
 * days since the most recent post that overlaps with the given candidate title.
 * Returns Infinity if the theory area has never been posted about.
 *
 * Matching: at least 2 significant words (≥5 chars) from the title appear
 * in the post text (bluesky_text, mastodon_text, or posts array joined).
 */
function getLastPostedByTheoryArea(candidateTitle) {
  const POSTS_DIR = 'workspace/logs/posts';
  let files = [];
  try {
    files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));
  } catch { return Infinity; }

  // Significant words from candidate title (≥5 chars, not stop words)
  const STOP = new Set(['their', 'which', 'about', 'after', 'where', 'there', 'these', 'those',
    'being', 'would', 'could', 'should', 'theory', 'power', 'state', 'class', 'labor',
    'history', 'political', 'social', 'working', 'against']);
  const titleWords = (candidateTitle.toLowerCase().match(/\b[a-z]{5,}\b/g) || [])
    .filter(w => !STOP.has(w));
  if (titleWords.length === 0) return Infinity;

  const now = Date.now();
  let mostRecentMs = null;

  for (const file of files) {
    let data;
    try { data = JSON.parse(readFileSync(`${POSTS_DIR}/${file}`, 'utf-8')); } catch { continue; }
    const entries = Object.values(data);
    for (const entry of entries) {
      if (!entry.logged_at) continue;
      // Extract all text from this post entry
      const parts = [];
      if (entry.bluesky_text) parts.push(entry.bluesky_text);
      if (entry.mastodon_text) parts.push(entry.mastodon_text);
      if (Array.isArray(entry.posts)) parts.push(...entry.posts.map(p => typeof p === 'string' ? p : (p.text || '')));
      const postText = parts.join(' ').toLowerCase();

      // Count overlapping title words in post text
      const matchCount = titleWords.filter(w => postText.includes(w)).length;
      const threshold = Math.max(2, Math.ceil(titleWords.length * 0.4));
      if (matchCount < threshold) continue;

      const entryMs = new Date(entry.logged_at).getTime();
      if (!isNaN(entryMs) && (mostRecentMs === null || entryMs > mostRecentMs)) {
        mostRecentMs = entryMs;
      }
    }
  }

  if (mostRecentMs === null) return Infinity;
  return (now - mostRecentMs) / (1000 * 60 * 60 * 24); // days
}

/**
 * Recency multiplier for candidate scoring.
 * Recently-posted theory areas score lower (avoid repetition).
 * Long-unposted areas score higher (time to revisit).
 */
function recencyMultiplier(daysSince) {
  if (daysSince === Infinity || daysSince >= 7) return 1.5;
  if (daysSince >= 4) return 1.0;
  if (daysSince >= 1) return 0.7;
  return 0.3; // posted today
}

/**
 * Promote top-scoring [candidate] items to [pending].
 * Scores by keyword overlap with Characters.md "Key exchange" / "Why they matter" text,
 * weighted by recency: theory areas not posted recently score higher (temporal diversity).
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
    const baseScore = words.filter(w => kwSet.has(w)).length;
    const daysSince = getLastPostedByTheoryArea(title);
    const multiplier = recencyMultiplier(daysSince);
    const finalScore = baseScore * multiplier;
    return { fullMatch: m[0], title, baseScore, daysSince, multiplier, finalScore };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const toPromote = scored.slice(0, maxPromote);

  const date = new Date().toISOString().split('T')[0];
  let updated = content;
  const promoted = [];
  for (const item of toPromote) {
    const daysNote = item.daysSince === Infinity ? 'never posted' : `${item.daysSince.toFixed(1)}d ago`;
    const replacement = item.fullMatch
      .replace('**[candidate]**', '**[pending]**')
      + ` *(promoted ${date}, score=${item.finalScore.toFixed(1)}, base=${item.baseScore}, recency=${item.multiplier}×, ${daysNote})*`;
    updated = updated.replace(item.fullMatch, replacement);
    promoted.push(item.title);
    console.log(`  → Promoted: "${item.title}" (score=${item.finalScore.toFixed(1)}, base=${item.baseScore}, recency=${item.multiplier}×, ${daysNote})`);
  }

  return { content: updated, count: promoted.length, titles: promoted };
}
