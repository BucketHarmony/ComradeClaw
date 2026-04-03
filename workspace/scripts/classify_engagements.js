#!/usr/bin/env node
/**
 * Backfill engagement classification for unclassified entries.
 *
 * Reads all workspace/logs/engagement/YYYY-MM.json files,
 * calls getProfile() for each unclassified entry, and writes
 * the classification back in place.
 *
 * Run: node workspace/scripts/classify_engagements.js
 */

import { BskyAgent } from '@atproto/api';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_PATH = path.join(__dirname, '..', '..');
const ENGAGEMENT_LOG_PATH = path.join(WORKSPACE_PATH, 'workspace', 'logs', 'engagement');

const ORGANIZER_KEYWORDS = [
  'cooperative', 'co-op', 'coop', 'mutual aid', 'union', 'labor', 'labour',
  'organiz', 'solidarity', 'worker', 'collective', 'community fridge',
  'dual power', 'strike', 'mutual', 'syndicalist', 'socialist', 'communist',
  'leftist', 'abolition', 'tenant', 'housing', 'autonomy', 'anarchist'
];

const AI_AGENT_KEYWORDS = [
  'ai agent', 'language model', 'llm', 'gpt', 'claude', 'artificial intelligence',
  'neural network', 'autonomous agent', 'bot', 'i am an ai', "i'm an ai"
];

function classifyFromProfile(bio, followersCount, followsCount, postsCount) {
  const bioLower = (bio || '').toLowerCase();
  if (AI_AGENT_KEYWORDS.some(k => bioLower.includes(k))) return 'ai-agent';
  if (postsCount < 5 && followsCount > 500) return 'bot';
  if (ORGANIZER_KEYWORDS.some(k => bioLower.includes(k))) return 'organizer';
  return 'general';
}

async function main() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !password) {
    console.error('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set.');
    process.exit(1);
  }

  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({ identifier: handle, password });
  console.log(`Logged in as ${handle}`);

  // Find all engagement log files
  let files;
  try {
    files = await fs.readdir(ENGAGEMENT_LOG_PATH);
  } catch {
    console.log('No engagement log directory found. Nothing to classify.');
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  console.log(`Found ${jsonFiles.length} log file(s): ${jsonFiles.join(', ')}`);

  let totalClassified = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const file of jsonFiles) {
    const filePath = path.join(ENGAGEMENT_LOG_PATH, file);
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));

    const unclassified = data.filter(e => e.classified === false);
    console.log(`\n${file}: ${data.length} total, ${unclassified.length} unclassified`);

    let modified = false;

    for (const entry of unclassified) {
      try {
        const res = await agent.getProfile({ actor: entry.handle });
        const p = res.data;
        const classification = classifyFromProfile(p.description, p.followersCount, p.followsCount, p.postsCount);

        const idx = data.findIndex(e => e.uri === entry.uri && e.classified === false);
        if (idx >= 0) {
          data[idx].classified = true;
          data[idx].classification = classification;
          data[idx].classified_at = new Date().toISOString();
          data[idx].profile_snapshot = {
            bio: (p.description || '').substring(0, 200),
            followers: p.followersCount || 0,
            following: p.followsCount || 0,
            posts: p.postsCount || 0
          };
          modified = true;
          totalClassified++;
          console.log(`  @${entry.handle} → ${classification}`);
        }

        // Rate limit courtesy: 300ms between profile lookups
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        console.warn(`  @${entry.handle} — failed: ${err.message}`);
        totalFailed++;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log(`  Saved ${file}`);
    } else {
      totalSkipped += unclassified.length;
    }
  }

  console.log(`\nDone. Classified: ${totalClassified}, Already done: ${totalSkipped}, Failed: ${totalFailed}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
