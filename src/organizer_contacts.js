/**
 * Organizer Contact Streak Tracker
 *
 * Reads engagement logs (Bluesky + Mastodon) and computes streak_status per handle:
 *   active  — engaged in last 3 days
 *   cooling — 3-7 days since last engagement (relationship to maintain)
 *   cold    — 7+ days since last engagement
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const ENGAGEMENT_PATH = path.join(PROJECT_ROOT, 'workspace', 'logs', 'engagement');

/**
 * Read all engagement log files and return per-handle streak data.
 * Returns array sorted by last engagement descending.
 */
export async function getOrganizerContacts() {
  const now = new Date();
  const byHandle = {};

  let files = [];
  try {
    const all = await fs.readdir(ENGAGEMENT_PATH);
    files = all.filter(f => f.endsWith('.json')).map(f => path.join(ENGAGEMENT_PATH, f));
  } catch {
    return [];
  }

  for (const logFile of files) {
    let entries = [];
    try {
      entries = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch {
      continue;
    }
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const handle = entry.handle;
      if (!handle) continue;
      const ts = new Date(entry.timestamp || entry.at);
      if (isNaN(ts)) continue;

      if (!byHandle[handle]) {
        byHandle[handle] = {
          handle,
          platform: entry.platform || 'bluesky',
          lastEngagement: ts,
          lastEngagementEntry: entry,
          interactionCount: 0
        };
      } else if (ts > byHandle[handle].lastEngagement) {
        byHandle[handle].lastEngagement = ts;
        byHandle[handle].lastEngagementEntry = entry;
      }
      byHandle[handle].interactionCount++;
    }
  }

  return Object.values(byHandle)
    .map(c => {
      const daysSince = (now - c.lastEngagement) / (1000 * 60 * 60 * 24);
      const streak_status = daysSince <= 3 ? 'active' : daysSince <= 7 ? 'cooling' : 'cold';
      const e = c.lastEngagementEntry || {};
      return {
        handle: c.handle,
        platform: c.platform,
        lastEngagement: c.lastEngagement.toISOString(),
        daysSince: Math.round(daysSince * 10) / 10,
        streak_status,
        interactionCount: c.interactionCount,
        lastEngagementType: e.type || null,
        lastEngagementUrl: e.status_url || e.uri || null,
        lastEngagementSnippet: (e.text_snippet || '').slice(0, 80) || null,
      };
    })
    .sort((a, b) => new Date(b.lastEngagement) - new Date(a.lastEngagement));
}

/**
 * Returns contacts in 'cooling' state (3-7 days since last engagement).
 * These are relationships worth re-engaging before they go cold.
 */
export async function getCoolingContacts() {
  const contacts = await getOrganizerContacts();
  return contacts.filter(c => c.streak_status === 'cooling');
}

/**
 * Returns contacts in 'cold' state (7-14 days since last engagement).
 * These are relationships slipping away — still recoverable but require real attention.
 * Beyond 14 days they're effectively gone and should not be surfaced.
 */
export async function getColdContacts() {
  const contacts = await getOrganizerContacts();
  return contacts.filter(c => {
    return c.streak_status === 'cold' && c.daysSince <= 14;
  });
}

// CLI: node src/organizer_contacts.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const contacts = await getOrganizerContacts();
  console.log(JSON.stringify(contacts, null, 2));
}
