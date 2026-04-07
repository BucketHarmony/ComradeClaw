#!/usr/bin/env node
/**
 * Backfill theory_interlocutor: true for known theory interlocutors
 * in all existing engagement log files.
 *
 * Reads cross_platform_identities.json, finds all identities with
 * theory_interlocutor: true, then updates matching engagement entries.
 *
 * Run once: node workspace/scripts/backfill_theory_interlocutors.js
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.join(__dirname, '..');
const IDS_PATH = path.join(WORKSPACE, 'memory', 'cross_platform_identities.json');
const ENGAGEMENT_PATH = path.join(WORKSPACE, 'logs', 'engagement');

async function run() {
  const raw = await fs.readFile(IDS_PATH, 'utf-8');
  const { identities } = JSON.parse(raw);
  const theoryIds = identities.filter(id => id.theory_interlocutor);
  if (!theoryIds.length) { console.log('No theory interlocutors found.'); return; }

  // Build a set of all bluesky and mastodon handles
  const handleMap = new Map(); // handle -> unified_id
  for (const id of theoryIds) {
    if (id.bluesky) handleMap.set(id.bluesky, id.unified_id);
    if (id.mastodon) handleMap.set(id.mastodon, id.unified_id);
  }

  const files = await fs.readdir(ENGAGEMENT_PATH);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  let totalUpdated = 0;
  for (const file of jsonFiles) {
    const filePath = path.join(ENGAGEMENT_PATH, file);
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    let modified = false;

    for (const entry of data) {
      const unifiedId = handleMap.get(entry.handle);
      if (unifiedId && !entry.theory_interlocutor) {
        entry.theory_interlocutor = true;
        entry.unified_id = entry.unified_id || unifiedId;
        modified = true;
        totalUpdated++;
      }
    }

    if (modified) {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
      console.log(`Updated ${file}: tagged theory interlocutors.`);
    }
  }

  console.log(`Done. ${totalUpdated} entries tagged across ${jsonFiles.length} file(s).`);
  console.log('Theory interlocutors:', theoryIds.map(id => id.unified_id).join(', '));
}

run().catch(console.error);
