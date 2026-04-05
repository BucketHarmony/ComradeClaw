/**
 * character-updater.js
 *
 * Non-blocking utility: when a known character re-engages (their handle appears
 * in read_replies or mastodon_read_notifications), update their Status line in
 * obsidian/ComradeClaw/Characters.md with:
 *   Last seen: YYYY-MM-DD — <one-line snippet>
 *
 * Exported function: updateCharacterLastSeen(handle, snippet)
 * Always non-fatal — caller must .catch(() => {})
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CHARACTERS_PATH = path.join(__dirname, '..', 'obsidian', 'ComradeClaw', 'Characters.md');

function normalizeHandle(handle) {
  // Strip leading @ and lowercase for comparison
  // Handles both Bluesky (democracyop.bsky.social) and Mastodon (mook@possum.city)
  return handle.replace(/^@+/, '').toLowerCase().trim();
}

function todayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Detroit' }); // YYYY-MM-DD
}

/**
 * Update the "Last seen" suffix on a character's Status line.
 *
 * @param {string} handle - Account handle (with or without leading @)
 * @param {string} snippet - One-line activity description (will be truncated to 100 chars)
 */
export async function updateCharacterLastSeen(handle, snippet) {
  try {
    const normalized = normalizeHandle(handle);
    if (!normalized) return;

    const raw = await fs.readFile(CHARACTERS_PATH, 'utf-8');
    const lines = raw.split('\n');

    // Walk sections: track which section owns the current handle match
    let inTargetSection = false;
    let handleFound = false;
    let statusLineIdx = -1;
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // New section header resets state
      if (line.startsWith('## ')) {
        if (inTargetSection && statusLineIdx !== -1) break; // done after first match
        inTargetSection = false;
        handleFound = false;
        statusLineIdx = -1;
      }

      // Detect Handle line in current section
      if (!handleFound && line.includes('**Handle:**')) {
        const m = line.match(/\*\*Handle:\*\*\s*(.+)/);
        if (m) {
          const charHandle = normalizeHandle(m[1].trim());
          if (charHandle === normalized) {
            handleFound = true;
            inTargetSection = true;
          }
        }
      }

      // Detect Status line once we are in the target section
      if (inTargetSection && line.match(/^\s*-\s*\*\*Status:\*\*/)) {
        statusLineIdx = i;
      }
    }

    if (!handleFound || statusLineIdx === -1) return; // Character not found or has no Status line

    const today = todayDate();
    const cleanSnippet = snippet
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 100);
    const lastSeenSuffix = `Last seen: ${today} — ${cleanSnippet}`;

    // Remove any existing "Last seen: ..." suffix then append fresh one
    const stripped = lines[statusLineIdx].replace(/\s*Last seen:.*$/, '').trimEnd();
    lines[statusLineIdx] = `${stripped} ${lastSeenSuffix}`;

    // Update frontmatter last-updated date
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('last-updated:')) {
        lines[i] = `last-updated: ${today}`;
        break;
      }
    }

    await fs.writeFile(CHARACTERS_PATH, lines.join('\n'), 'utf-8');
  } catch {
    // Non-fatal — never block notification flow
  }
}
