/**
 * Shared Persistent Chat History
 *
 * Single JSON file shared between CLI and Discord.
 * Lightweight filtering to keep context window useful.
 * Store everything, filter at read time.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const HISTORY_FILE = path.join(WORKSPACE_PATH, 'logs', 'chat', 'history.json');
const MAX_CONTEXT_EXCHANGES = 20;

// Messages matching these patterns get filtered from context window
const SKIP_PATTERNS = [
  /^(status|ping|health)$/i,
  /^(pause|unpause)$/i,
  /^post now$/i,
  /^clear$/i,
  /^help$/i,
  /^\/\w+$/,  // slash commands
];

/**
 * Generate a unique message ID
 */
function generateId() {
  return 'msg_' + randomBytes(8).toString('hex');
}

/**
 * Check if a message should be filtered from context
 */
export function shouldFilter(content) {
  const trimmed = content.trim();
  return SKIP_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Load history from disk
 * Returns { version, messages } or creates new if missing/corrupt
 */
export async function loadHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(data);

    if (!parsed.version || !Array.isArray(parsed.messages)) {
      throw new Error('Invalid history format');
    }

    console.log(`[history] Loaded ${parsed.messages.length} messages from disk`);
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[history] No history file, starting fresh');
    } else {
      console.warn(`[history] Could not load history: ${error.message}`);
      // Backup corrupt file
      try {
        await fs.rename(HISTORY_FILE, HISTORY_FILE + '.bak');
        console.log('[history] Renamed corrupt file to history.json.bak');
      } catch {}
    }

    return { version: 1, messages: [] };
  }
}

/**
 * Save history atomically (write to .tmp, rename)
 */
async function saveHistory(history) {
  const dir = path.dirname(HISTORY_FILE);
  await fs.mkdir(dir, { recursive: true });

  const tmpFile = HISTORY_FILE + '.tmp';
  await fs.writeFile(tmpFile, JSON.stringify(history, null, 2));
  await fs.rename(tmpFile, HISTORY_FILE);
}

/**
 * Save an exchange (user message + assistant response)
 */
export async function saveExchange(userContent, assistantContent, channel = 'unknown') {
  const history = await loadHistory();
  const timestamp = new Date().toISOString();
  const userFiltered = shouldFilter(userContent);

  // User message
  history.messages.push({
    id: generateId(),
    timestamp,
    channel,
    role: 'user',
    content: userContent,
    filtered: userFiltered
  });

  // Assistant response (filtered if user message was filtered)
  history.messages.push({
    id: generateId(),
    timestamp,
    channel,
    role: 'assistant',
    content: assistantContent,
    filtered: userFiltered
  });

  await saveHistory(history);
  console.log(`[history] Saved exchange (filtered: ${userFiltered})`);
}

/**
 * Get messages formatted for LLM context window
 * Filters out filtered messages, caps at MAX_CONTEXT_EXCHANGES
 */
export function getContextMessages(history) {
  const unfiltered = history.messages.filter(m => !m.filtered);
  const capped = unfiltered.slice(-MAX_CONTEXT_EXCHANGES * 2);

  // Convert to API format (just role + content)
  return capped.map(m => ({
    role: m.role,
    content: m.content
  }));
}

/**
 * Clear history (for /clear command)
 */
export async function clearHistory() {
  const history = { version: 1, messages: [] };
  await saveHistory(history);
  console.log('[history] Cleared history');
  return history;
}

export default {
  loadHistory,
  saveExchange,
  getContextMessages,
  clearHistory,
  shouldFilter
};
