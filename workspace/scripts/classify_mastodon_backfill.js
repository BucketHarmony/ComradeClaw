#!/usr/bin/env node
/**
 * One-shot backfill: classify all unclassified Mastodon engagement log entries.
 * Run: node workspace/scripts/classify_mastodon_backfill.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const ENGAGEMENT_DIR = path.join(PROJECT_ROOT, 'workspace', 'logs', 'engagement');

const TOKEN = process.env.MASTODON_ACCESS_TOKEN;
const BASE_URL = 'https://mastodon.social/api/v1';

if (!TOKEN) {
  console.error('MASTODON_ACCESS_TOKEN not set — load .env first');
  process.exit(1);
}

async function masto(endpoint, opts = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Mastodon API ${res.status}: ${await res.text()}`);
  return res.json();
}

const ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'coop', 'mutual aid', 'union', 'labor', 'labour',
  'organiz', 'solidarity', 'worker', 'collective', 'community fridge',
  'dual power', 'strike', 'syndicalist', 'socialist', 'communist',
  'leftist', 'abolition', 'tenant', 'housing', 'autonomy', 'anarchist',
  'revolution', 'liberation', 'palestine', 'anti-capitalist', 'anti-imperialist',
  'decolonial', 'decoloniz', 'proletariat', 'emancipat', 'radical', 'resistance',
  'free palestine', 'class struggle', 'class war', 'direct action'
];
const AI_KEYWORDS = ['ai agent', 'language model', 'llm', 'gpt', 'claude', 'artificial intelligence', 'autonomous agent', 'i am an ai', "i'm an ai"];

function classify(note, followers, following, statuses) {
  const bio = (note || '').toLowerCase().replace(/<[^>]*>/g, '');
  if (AI_KEYWORDS.some(k => bio.includes(k))) return 'ai-agent';
  if (statuses < 5 && following > 500) return 'bot';
  if (ORGANIZER_KEYWORDS.some(k => bio.includes(k))) return 'organizer';
  return 'general';
}

const files = (await fs.readdir(ENGAGEMENT_DIR).catch(() => [])).filter(f => f.endsWith('.json'));

for (const file of files) {
  const filePath = path.join(ENGAGEMENT_DIR, file);
  let entries;
  try {
    entries = JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch { continue; }
  if (!Array.isArray(entries)) continue;

  const unclassifiedHandles = [...new Set(
    entries.filter(e => !e.classified && e.handle).map(e => e.handle)
  )];
  if (unclassifiedHandles.length === 0) {
    console.log(`${file}: all ${entries.length} entries already classified`);
    continue;
  }

  console.log(`${file}: ${unclassifiedHandles.length} unique handles to classify...`);
  const profileCache = {};
  for (const handle of unclassifiedHandles) {
    try {
      const results = await masto(`/accounts/search?q=${encodeURIComponent(handle)}&limit=1&resolve=true`);
      if (results.length > 0) {
        profileCache[handle] = results[0];
        console.log(`  ${handle}: found (${results[0].followers_count} followers)`);
      } else {
        console.log(`  ${handle}: no results`);
      }
    } catch (e) {
      console.log(`  ${handle}: error — ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 300)); // rate limit
  }

  let changed = 0;
  for (const entry of entries) {
    if (entry.classified || !entry.handle) continue;
    const profile = profileCache[entry.handle];
    if (!profile) continue;
    const bio = (profile.note || '').replace(/<[^>]*>/g, '');
    entry.classified = true;
    entry.classification = classify(bio, profile.followers_count, profile.following_count, profile.statuses_count);
    entry.classified_at = new Date().toISOString();
    entry.profile_snapshot = {
      bio: bio.substring(0, 500),
      followers: profile.followers_count,
      following: profile.following_count,
      posts: profile.statuses_count,
    };
    changed++;
  }

  if (changed > 0) {
    await fs.writeFile(filePath, JSON.stringify(entries, null, 2));
    const orgs = [...new Set(entries.filter(e => e.classification === 'organizer').map(e => e.handle))];
    const ai = [...new Set(entries.filter(e => e.classification === 'ai-agent').map(e => e.handle))];
    const gen = [...new Set(entries.filter(e => e.classification === 'general').map(e => e.handle))];
    console.log(`  Updated ${changed} entries. organizers=${orgs.join(', ')} ai-agents=${ai.join(', ')} general=${gen.join(', ')}`);
  } else {
    console.log(`  No changes needed.`);
  }
}

console.log('\nDone.');
