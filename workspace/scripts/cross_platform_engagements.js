#!/usr/bin/env node
/**
 * cross_platform_engagements.js
 *
 * Reads Bluesky + Mastodon engagement logs, finds cross-platform organizers,
 * reports platform-exclusive contacts, and surfaces top topics per platform.
 *
 * Usage:
 *   node workspace/scripts/cross_platform_engagements.js [--month YYYY-MM] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const monthArg = args.find(a => a.startsWith('--month'));
const month = monthArg ? monthArg.split('=')[1] || args[args.indexOf(monthArg) + 1] : getCurrentMonth();

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ── Load engagement logs ───────────────────────────────────────────────────

function loadLog(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

const bskyPath = path.join(ROOT, 'workspace', 'logs', 'engagement', `${month}.json`);
const mastoPath = path.join(ROOT, 'workspace', 'logs', 'engagement', `mastodon-${month}.json`);
const mapPath = path.join(ROOT, 'workspace', 'scripts', 'cross_platform_map.json');

const bskyRaw = loadLog(bskyPath);
const mastoRaw = loadLog(mastoPath);

// Load optional cross-platform handle mapping: { "user@instance": "user.bsky.social", ... }
let crossMap = {};
try {
  crossMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
} catch {
  // No mapping file — cross-platform detection limited to map entries
}

// ── Deduplicate entries by URI / status_id ─────────────────────────────────

function dedupeByField(arr, field) {
  const seen = new Set();
  return arr.filter(e => {
    const key = e[field];
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const bsky = dedupeByField(bskyRaw, 'uri');
const masto = dedupeByField(mastoRaw, 'status_id');

// ── Aggregate per-platform contacts ───────────────────────────────────────

function aggregateContacts(entries, platform) {
  const contacts = new Map();
  for (const e of entries) {
    const handle = e.handle;
    if (!handle) continue;
    if (!contacts.has(handle)) {
      contacts.set(handle, {
        handle,
        platform,
        display_name: e.display_name || null,
        engagement_count: 0,
        types: {},
        classification: e.classification || null,
        snippets: [],
      });
    }
    const c = contacts.get(handle);
    c.engagement_count++;
    c.types[e.type] = (c.types[e.type] || 0) + 1;
    if (e.text_snippet && c.snippets.length < 3) {
      c.snippets.push(e.text_snippet.slice(0, 80));
    }
    // Classification from most recent classified entry
    if (e.classification && !c.classification) c.classification = e.classification;
  }
  return contacts;
}

const bskyContacts = aggregateContacts(bsky, 'bluesky');
const mastoContacts = aggregateContacts(masto, 'mastodon');

// ── Cross-platform matching ────────────────────────────────────────────────
// Strategy: use crossMap (mastodon handle → bluesky handle) for known links.
// Also try display_name matching as a weak signal (not authoritative).

const crossPlatform = []; // { mastodon_handle, bluesky_handle, confidence, ... }
const mastoOnly = [];
const bskyOnly = [];

// Build reverse map: bluesky handle → mastodon handle
const reverseCrossMap = {};
for (const [mastoH, bskyH] of Object.entries(crossMap)) {
  reverseCrossMap[bskyH] = mastoH;
}

// Find known cross-platform contacts
const matchedMasto = new Set();
const matchedBsky = new Set();

for (const [mastoH, bskyH] of Object.entries(crossMap)) {
  const mastoC = mastoContacts.get(mastoH);
  const bskyC = bskyContacts.get(bskyH);
  if (mastoC || bskyC) {
    crossPlatform.push({
      mastodon_handle: mastoH,
      bluesky_handle: bskyH,
      confidence: 'confirmed',
      mastodon_engagements: mastoC?.engagement_count || 0,
      bluesky_engagements: bskyC?.engagement_count || 0,
      classification: bskyC?.classification || 'unknown',
      is_priority: bskyC?.classification === 'organizer',
    });
    if (mastoC) matchedMasto.add(mastoH);
    if (bskyC) matchedBsky.add(bskyH);
  }
}

// Weak display_name matching for unmatched contacts
const bskyByName = new Map();
for (const [h, c] of bskyContacts) {
  if (!matchedBsky.has(h) && c.display_name) {
    bskyByName.set(c.display_name.toLowerCase().trim(), h);
  }
}

for (const [mastoH, mastoC] of mastoContacts) {
  if (matchedMasto.has(mastoH)) continue;
  // Mastodon logs don't currently store display_name — skip name match
  mastoOnly.push(mastoC);
}

for (const [bskyH, bskyC] of bskyContacts) {
  if (matchedBsky.has(bskyH)) continue;
  bskyOnly.push(bskyC);
}

// ── Topic extraction from text snippets ───────────────────────────────────

const TOPIC_KEYWORDS = [
  ['cooperative', 'coop', 'co-op', 'worker-owned'],
  ['mutual aid', 'free fridge', 'pantry', 'solidarity fund'],
  ['labor', 'union', 'strike', 'organizing', 'wage'],
  ['dual power', 'infrastructure', 'prefiguration'],
  ['Hampton', 'BPP', 'Black Panther', 'rainbow coalition'],
  ['Mastodon', 'fediverse', 'ActivityPub'],
  ['AI', 'agent', 'autonomous', 'robot'],
  ['theory', 'Marxist', 'anarchist', 'socialist'],
];

function extractTopics(snippets) {
  const counts = {};
  for (const snippet of snippets) {
    const lower = snippet.toLowerCase();
    for (const group of TOPIC_KEYWORDS) {
      const label = group[0];
      if (group.some(kw => lower.includes(kw))) {
        counts[label] = (counts[label] || 0) + 1;
      }
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

const bskySnippets = bsky.map(e => e.text_snippet || '');
const mastoSnippets = masto.map(e => e.text_snippet || '');
const bskyTopics = extractTopics(bskySnippets);
const mastoTopics = extractTopics(mastoSnippets);

// ── Organizer identification ───────────────────────────────────────────────

// Bluesky: use classification field
const bskyOrganizers = [...bskyContacts.values()].filter(c => c.classification === 'organizer');

// Mastodon: keyword classification (mirrors classifyMastodonBio pattern)
const ORGANIZER_KEYWORDS = ['organiz', 'union', 'cooperative', 'mutual aid', 'labor', 'labour',
  'socialist', 'communist', 'anarchist', 'worker', 'solidarity', 'activist', 'movement'];

function classifyMastoHandle(handle) {
  const lower = handle.toLowerCase();
  return ORGANIZER_KEYWORDS.some(kw => lower.includes(kw));
}

const mastoOrganizers = [...mastoContacts.values()].filter(c => {
  // Check handle keywords as weak signal (bio not available in log)
  return c.classification === 'organizer' || classifyMastoHandle(c.handle);
});

// Priority contacts: organizer on both platforms (via cross-platform map)
const priorityContacts = crossPlatform.filter(c => c.is_priority);

// ── Build report ──────────────────────────────────────────────────────────

const report = {
  month,
  generated_at: new Date().toISOString(),
  summary: {
    bluesky_total_engagements: bsky.length,
    bluesky_unique_contacts: bskyContacts.size,
    bluesky_organizers: bskyOrganizers.length,
    mastodon_total_engagements: masto.length,
    mastodon_unique_contacts: mastoContacts.size,
    mastodon_organizer_handles: mastoOrganizers.length,
    cross_platform_known: crossPlatform.length,
    priority_contacts: priorityContacts.length,
  },
  cross_platform: crossPlatform,
  priority_contacts: priorityContacts,
  bluesky_only: bskyOnly.sort((a, b) => b.engagement_count - a.engagement_count).slice(0, 10),
  mastodon_only: mastoOnly.sort((a, b) => b.engagement_count - a.engagement_count).slice(0, 10),
  bluesky_organizers: bskyOrganizers.sort((a, b) => b.engagement_count - a.engagement_count),
  mastodon_organizer_handles: mastoOrganizers.sort((a, b) => b.engagement_count - a.engagement_count),
  top_topics: {
    bluesky: bskyTopics,
    mastodon: mastoTopics,
  },
  note: crossPlatform.length === 0
    ? `No cross-platform links found. Add known mappings to ${mapPath} as { "user@instance": "user.bsky.social" }.`
    : `${crossPlatform.length} cross-platform contact(s) confirmed via mapping file.`,
};

// ── Output ─────────────────────────────────────────────────────────────────

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n=== Cross-Platform Engagement Report: ${month} ===\n`);

  console.log('SUMMARY');
  console.log(`  Bluesky:  ${report.summary.bluesky_total_engagements} engagements, ${report.summary.bluesky_unique_contacts} contacts, ${report.summary.bluesky_organizers} organizers`);
  console.log(`  Mastodon: ${report.summary.mastodon_total_engagements} engagements, ${report.summary.mastodon_unique_contacts} contacts, ${report.summary.mastodon_organizer_handles} organizer-pattern handles`);
  console.log(`  Cross-platform confirmed: ${report.summary.cross_platform_known}`);
  console.log(`  Priority contacts (organizer on both): ${report.summary.priority_contacts}`);

  if (crossPlatform.length > 0) {
    console.log('\nCROSS-PLATFORM CONTACTS');
    for (const c of crossPlatform) {
      const tag = c.is_priority ? ' ⭐ PRIORITY' : '';
      console.log(`  ${c.mastodon_handle} ↔ ${c.bluesky_handle}${tag}`);
      console.log(`    Mastodon: ${c.mastodon_engagements} | Bluesky: ${c.bluesky_engagements} | class: ${c.classification}`);
    }
  } else {
    console.log(`\n${report.note}`);
  }

  if (bskyOrganizers.length > 0) {
    console.log('\nBLUESKY ORGANIZERS');
    for (const c of bskyOrganizers) {
      console.log(`  ${c.handle} (${c.display_name || '?'}) — ${c.engagement_count} engagements`);
      if (c.snippets[0]) console.log(`    "${c.snippets[0]}"`);
    }
  }

  if (mastoOrganizers.length > 0) {
    console.log('\nMASTODON ORGANIZER-PATTERN HANDLES');
    for (const c of mastoOrganizers) {
      console.log(`  ${c.handle} — ${c.engagement_count} engagements (${Object.entries(c.types).map(([k,v])=>`${k}:${v}`).join(', ')})`);
      if (c.snippets[0]) console.log(`    "${c.snippets[0]}"`);
    }
  }

  console.log('\nTOP TOPICS BY PLATFORM');
  console.log('  Bluesky:');
  if (bskyTopics.length === 0) console.log('    (no matched topics)');
  for (const [topic, count] of bskyTopics) console.log(`    ${topic}: ${count} mentions`);
  console.log('  Mastodon:');
  if (mastoTopics.length === 0) console.log('    (no matched topics)');
  for (const [topic, count] of mastoTopics) console.log(`    ${topic}: ${count} mentions`);

  console.log('\nTOP BLUESKY-ONLY CONTACTS');
  for (const c of report.bluesky_only.slice(0, 5)) {
    const cls = c.classification ? ` [${c.classification}]` : '';
    console.log(`  ${c.handle}${cls} — ${c.engagement_count} engagements`);
  }

  console.log('\nTOP MASTODON-ONLY CONTACTS');
  for (const c of report.mastodon_only.slice(0, 5)) {
    console.log(`  ${c.handle} — ${c.engagement_count} engagements`);
  }

  console.log('\n─────────────────────────────────────────────────────────');
  console.log(`To add cross-platform mappings: ${mapPath}`);
  console.log('Format: { "mastodon@instance": "bluesky.handle" }');
  console.log('─────────────────────────────────────────────────────────\n');
}
