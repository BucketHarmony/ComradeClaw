/**
 * One-time backfill: fetch up to 80 past Mastodon favourites and append
 * any entries missing from workspace/logs/favs/mastodon-favs-YYYY-MM.json.
 *
 * Closes the retroactive gap created when logMastodonFavourites() was added
 * (improve6, 2026-04-08) — the log started empty so fav-heavy older posts
 * were invisible to getMastodonSpreadAlert().
 *
 * Safe to re-run: deduplicates on account+status_id before writing.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const INSTANCE = process.env.MASTODON_INSTANCE || 'https://mastodon.social';
const TOKEN = process.env.MASTODON_ACCESS_TOKEN;
const FAVS_DIR = path.join(ROOT, 'workspace', 'logs', 'favs');

async function masto(endpoint) {
  if (!TOKEN) throw new Error('MASTODON_ACCESS_TOKEN not set');
  const url = `${INSTANCE}/api/v1${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`Mastodon API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function run() {
  // Fetch up to 80 favourite notifications
  const raw = await masto('/notifications?types[]=favourite&limit=80');
  console.log(`Fetched ${raw.length} favourite notifications from API`);

  if (raw.length === 0) {
    console.log('No favourites found — nothing to backfill.');
    return;
  }

  // Transform to the same shape logMastodonFavourites expects
  const items = raw.map(n => ({
    type: n.type,
    created_at: n.created_at,
    account: n.account?.acct,
    status_id: n.status?.id,
    status_url: n.status?.url,
  }));

  // Group by month (use the notification's own timestamp)
  const byMonth = new Map();
  for (const item of items) {
    if (item.type !== 'favourite' || !item.account || !item.status_id) continue;
    const ts = new Date(item.created_at);
    const month = ts.toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }).substring(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(item);
  }

  await fs.mkdir(FAVS_DIR, { recursive: true });
  let totalAdded = 0;

  for (const [month, monthItems] of byMonth) {
    const logFile = path.join(FAVS_DIR, `mastodon-favs-${month}.json`);
    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(logFile, 'utf-8'));
    } catch { /* new file */ }

    const dedupKey = e => `${e.account}:${e.status_id}`;
    const seenKeys = new Set(existing.map(dedupKey));
    const now = new Date().toISOString();
    let added = 0;

    for (const item of monthItems) {
      const key = `${item.account}:${item.status_id}`;
      if (seenKeys.has(key)) continue;
      existing.push({
        platform: 'mastodon',
        type: 'favourite',
        account: item.account,
        status_id: item.status_id,
        status_url: item.status_url || null,
        timestamp: item.created_at,
        logged_at: now,
        backfilled: true,
      });
      seenKeys.add(key);
      added++;
    }

    // Sort by timestamp ascending
    existing.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    await fs.writeFile(logFile, JSON.stringify(existing, null, 2));
    console.log(`  ${month}: +${added} new entries (${existing.length} total) → ${logFile}`);
    totalAdded += added;
  }

  console.log(`\nBackfill complete. ${totalAdded} entries added across ${byMonth.size} month file(s).`);
}

run().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
