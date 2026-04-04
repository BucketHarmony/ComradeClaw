#!/usr/bin/env node
/**
 * organizer_contacts.js
 *
 * Answers: "Who interacted with us this week and what did they talk about?"
 *
 * Scans engagement logs, groups by handle (organizer-classified on Bluesky;
 * all mentions/reblogs on Mastodon), outputs ranked list by interaction frequency.
 *
 * Usage:
 *   node workspace/scripts/organizer_contacts.js
 *   node workspace/scripts/organizer_contacts.js --days 14
 *   node workspace/scripts/organizer_contacts.js --month 2026-04
 *   node workspace/scripts/organizer_contacts.js --json
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../');
const ENGAGEMENT_DIR = join(ROOT, 'workspace/logs/engagement');

// --- CLI args ---
const args = process.argv.slice(2);
const daysArg = args.find(a => a.startsWith('--days=') || a === '--days');
const monthArg = args.find(a => a.startsWith('--month=') || a === '--month');
const jsonMode = args.includes('--json');

let days = 7;
if (daysArg) {
  const val = daysArg.includes('=') ? daysArg.split('=')[1] : args[args.indexOf('--days') + 1];
  days = parseInt(val, 10) || 7;
}

let targetMonth = null;
if (monthArg) {
  targetMonth = monthArg.includes('=') ? monthArg.split('=')[1] : args[args.indexOf('--month') + 1];
}

// --- Date window ---
const now = new Date();
const windowStart = targetMonth
  ? new Date(`${targetMonth}-01T00:00:00Z`)
  : new Date(now - days * 24 * 60 * 60 * 1000);
const windowEnd = targetMonth
  ? new Date(new Date(`${targetMonth}-01T00:00:00Z`).setMonth(new Date(`${targetMonth}-01T00:00:00Z`).getMonth() + 1))
  : now;

// --- Load engagement files ---
function loadEngagementFiles() {
  if (!existsSync(ENGAGEMENT_DIR)) return [];

  const files = readdirSync(ENGAGEMENT_DIR).filter(f => f.endsWith('.json'));
  const entries = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(ENGAGEMENT_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        entries.push(...data.map(e => ({ ...e, _source_file: file })));
      }
    } catch {
      // Skip malformed files
    }
  }

  return entries;
}

// Organizer keyword signals for Mastodon (no classification field)
const ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'union', 'labor', 'labour', 'mutual aid', 'solidarity',
  'organiz', 'fediverse', 'collective', 'worker', 'community', 'anarchi', 'socialist',
  'comrade', 'radical', 'liberation', 'movement', 'abolish', 'decoloni', 'justice',
];

const AI_SIGNALS = ['ai', 'bot', 'llm', 'gpt', 'claude', 'artificial', 'newsmast'];

function looksMastodonOrganizer(entry) {
  // Exclude obvious AI/bot accounts
  const handle = (entry.handle || '').toLowerCase();
  if (AI_SIGNALS.some(s => handle.includes(s))) return false;

  // Mentions are likely organizers if they're actual conversation
  if (entry.type === 'mention') return true;

  // For reblogs, require some organizer signal in the reblogged snippet
  if (entry.type === 'reblog') {
    const snippet = (entry.text_snippet || '').toLowerCase();
    return ORGANIZER_KEYWORDS.some(kw => snippet.includes(kw));
  }

  return false;
}

// --- Filter logic ---
function isOrganizerEntry(entry) {
  const ts = new Date(entry.timestamp || entry.logged_at);
  if (ts < windowStart || ts >= windowEnd) return false;

  // Mastodon entries: keyword-filtered (no classification field yet)
  if (entry.platform === 'mastodon') {
    return looksMastodonOrganizer(entry);
  }

  // Bluesky entries: organizer-classified only
  return entry.classification === 'organizer';
}

// --- Deduplication ---
function deduplicateEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    // Build dedup key from handle + type + unique identifier
    const uid = entry.status_id || entry.uri || entry.text_snippet?.slice(0, 50) || '';
    const key = `${entry.handle}:${entry.type}:${uid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- Decode HTML entities ---
function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// --- Main ---
const allEntries = deduplicateEntries(loadEngagementFiles());
const filtered = allEntries.filter(isOrganizerEntry);

// Group by handle
const byHandle = {};
for (const entry of filtered) {
  const key = entry.handle;
  if (!byHandle[key]) {
    byHandle[key] = {
      handle: key,
      display_name: entry.display_name || null,
      platform: entry.platform || 'bluesky',
      interactions: [],
      types: {},
      profile: entry.profile_snapshot || null,
      classification: entry.classification || 'mastodon-fediverse',
    };
  }

  const contact = byHandle[key];

  // Track interaction types
  contact.types[entry.type] = (contact.types[entry.type] || 0) + 1;

  // Store interaction with context
  contact.interactions.push({
    timestamp: entry.timestamp || entry.logged_at,
    type: entry.type,
    text_snippet: decodeHtml(entry.text_snippet || '').trim(),
    our_post_uri: entry.in_reply_to_our_post || null,
    url: entry.status_url || entry.uri || null,
  });
}

// Sort by interaction count (desc), then by most recent interaction
const ranked = Object.values(byHandle).sort((a, b) => {
  const diff = b.interactions.length - a.interactions.length;
  if (diff !== 0) return diff;
  // Tie-break by most recent
  const aLatest = Math.max(...a.interactions.map(i => new Date(i.timestamp)));
  const bLatest = Math.max(...b.interactions.map(i => new Date(i.timestamp)));
  return bLatest - aLatest;
});

// --- Output ---
if (jsonMode) {
  console.log(JSON.stringify({ window_start: windowStart, window_end: windowEnd, contacts: ranked }, null, 2));
  process.exit(0);
}

const windowLabel = targetMonth
  ? `month ${targetMonth}`
  : `last ${days} days`;

console.log(`\n=== Organizer Contacts (${windowLabel}) ===`);
console.log(`Window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}`);
console.log(`Total organizer interactions: ${filtered.length}`);
console.log(`Unique contacts: ${ranked.length}`);
console.log('');

if (ranked.length === 0) {
  console.log('No organizer interactions in this window.');
  console.log('(Bluesky requires classification=organizer; Mastodon includes all mentions/reblogs)');
  process.exit(0);
}

for (const contact of ranked) {
  const name = contact.display_name ? `${contact.display_name} ` : '';
  const platform = contact.platform === 'mastodon' ? '[Mastodon]' : '[Bluesky]';
  const typeBreakdown = Object.entries(contact.types)
    .map(([t, n]) => `${n}×${t}`)
    .join(', ');

  console.log(`── ${name}@${contact.handle} ${platform}`);
  console.log(`   Interactions: ${contact.interactions.length} (${typeBreakdown})`);
  if (contact.classification !== 'mastodon-fediverse') {
    console.log(`   Classification: ${contact.classification}`);
  }
  if (contact.profile) {
    const p = contact.profile;
    if (p.bio) console.log(`   Bio: ${p.bio.slice(0, 120).replace(/\n/g, ' ')}`);
    if (p.followers !== undefined) console.log(`   Followers: ${p.followers}`);
  }

  // Show up to 3 most recent text snippets
  const withText = contact.interactions
    .filter(i => i.text_snippet && i.text_snippet.length > 5)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 3);

  if (withText.length > 0) {
    console.log('   Recent messages:');
    for (const i of withText) {
      const date = new Date(i.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      const snippet = i.text_snippet.slice(0, 120);
      console.log(`     [${date}] (${i.type}) "${snippet}${snippet.length < i.text_snippet.length ? '…' : ''}"`);
    }
  }

  console.log('');
}

console.log(`Follow-up checklist:`);
for (const contact of ranked) {
  const latest = contact.interactions.reduce((a, b) =>
    new Date(a.timestamp) > new Date(b.timestamp) ? a : b
  );
  const daysSince = Math.floor((now - new Date(latest.timestamp)) / (1000 * 60 * 60 * 24));
  const flag = daysSince >= 3 ? ' ⚑ (overdue)' : '';
  const name = contact.display_name || contact.handle;
  console.log(`  [ ] ${name} — last contact ${daysSince}d ago${flag}`);
}
