/**
 * Cross-platform identity resolution.
 *
 * Maps known organizers who appear on multiple platforms to a stable unified_id.
 * Used when logging engagement — adds unified_id to engagement log entries so that
 * stats for the same person aggregate correctly across Bluesky and Mastodon.
 *
 * Identity map: workspace/memory/cross_platform_identities.json
 * Handle formats:
 *   bluesky  — bare handle, e.g. "mook.bsky.social"
 *   mastodon — full acct,  e.g. "mook@possum.city"
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDENTITIES_PATH = path.join(__dirname, '../../workspace/memory/cross_platform_identities.json');

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 min — file changes rarely but we want fresh lookups

async function loadIdentities() {
  if (_cache && Date.now() - _cacheAt < CACHE_TTL) return _cache;
  try {
    const data = JSON.parse(await fs.readFile(IDENTITIES_PATH, 'utf-8'));
    _cache = Array.isArray(data.identities) ? data.identities : [];
    _cacheAt = Date.now();
    return _cache;
  } catch {
    return [];
  }
}

/**
 * Given a platform and handle, return the unified_id if this person is known
 * across platforms. Returns null if no match.
 *
 * @param {'bluesky'|'mastodon'} platform
 * @param {string} handle - bare Bluesky handle or full Mastodon acct
 * @returns {Promise<string|null>}
 */
export async function getUnifiedId(platform, handle) {
  if (!handle) return null;
  const identities = await loadIdentities();
  const normalized = handle.toLowerCase().replace(/^@/, '');
  for (const identity of identities) {
    const platformHandle = identity[platform];
    if (!platformHandle) continue;
    if (platformHandle.toLowerCase() === normalized) return identity.unified_id;
  }
  return null;
}

/**
 * Return all known identities. Useful for audit/display.
 * @returns {Promise<Array>}
 */
export async function getAllIdentities() {
  return loadIdentities();
}

/**
 * Invalidate the in-memory cache. Call after programmatically writing the identities file.
 */
export function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}
