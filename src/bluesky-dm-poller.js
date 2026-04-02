/**
 * Bluesky DM Poller
 *
 * Polls the Bluesky chat API every 5 minutes for new DMs.
 * When unread conversations are found, fires a wake with the sender
 * and message preview injected as priority context.
 *
 * State file: workspace/bluesky/last_dm_seen.json
 * {
 *   "convos": { "<convoId>": "<ISO updatedAt>" },
 *   "last_wake_fired": "<ISO timestamp>"
 * }
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const STATE_FILE = path.join(WORKSPACE_PATH, 'bluesky', 'last_dm_seen.json');

// Rate limit: don't fire DM wakes more often than this
const MIN_WAKE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000;     // poll every 5 minutes

const CHAT_PROXY_HEADER = { 'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat' };

// Cached agent (shared auth, 10-min expiry)
let _agent = null;
let _agentExpiry = 0;

async function getAgent() {
  if (_agent && Date.now() < _agentExpiry) return { agent: _agent };

  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) return { error: 'BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set' };

  try {
    const { BskyAgent } = await import('@atproto/api');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password });
    _agent = agent;
    _agentExpiry = Date.now() + 10 * 60 * 1000;
    return { agent };
  } catch (err) {
    return { error: `Bluesky login failed: ${err.message}` };
  }
}

async function chatCall(agent, method, params = {}) {
  const parts = method.split('.');
  let obj = agent.api;
  let parent = agent.api;
  for (const part of parts) {
    parent = obj;
    obj = obj[part];
    if (obj == null) throw new Error(`Chat method not found: ${method}`);
  }
  return obj.call(parent, params, { headers: CHAT_PROXY_HEADER });
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { convos: {}, last_wake_fired: null };
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Main poll function. Returns array of new-message summaries, or [].
 * Fires a wake via the callback if new messages are found and rate limit allows.
 */
export async function pollDMs(fireWake) {
  const { agent, error } = await getAgent();
  if (error) {
    console.log(`[dm-poller] Auth error: ${error}`);
    return;
  }

  let convosRes;
  try {
    convosRes = await chatCall(agent, 'chat.bsky.convo.listConvos', { limit: 20 });
  } catch (err) {
    console.log(`[dm-poller] listConvos failed: ${err.message}`);
    return;
  }

  const convos = convosRes.data?.convos || [];
  const state = await readState();
  const newMessages = [];

  for (const convo of convos) {
    const { id, unreadCount, lastMessage, members } = convo;
    if (!unreadCount || unreadCount === 0) continue;

    const lastUpdated = lastMessage?.sentAt || convo.updatedAt;
    const prevSeen = state.convos[id];

    // Skip if we've already seen this update
    if (prevSeen && new Date(prevSeen) >= new Date(lastUpdated)) continue;

    // Find the other party (not us)
    const myDid = agent.session.did;
    const other = members?.find(m => m.did !== myDid);
    const handle = other?.handle || other?.did || 'unknown';
    const text = lastMessage?.text || '(no text)';
    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;

    newMessages.push({ convoId: id, handle, preview, lastUpdated });
    state.convos[id] = lastUpdated;
  }

  if (newMessages.length === 0) {
    await writeState(state); // persist any seen-state updates
    return;
  }

  // Check rate limit
  const now = Date.now();
  const lastFired = state.last_wake_fired ? new Date(state.last_wake_fired).getTime() : 0;
  if (now - lastFired < MIN_WAKE_INTERVAL_MS) {
    console.log(`[dm-poller] ${newMessages.length} new DM(s) found but rate-limited (last wake ${Math.round((now - lastFired) / 1000)}s ago)`);
    await writeState(state);
    return;
  }

  // Build purpose string for the wake
  const senders = [...new Set(newMessages.map(m => `@${m.handle}`))].join(', ');
  const firstMsg = newMessages[0];
  const purpose = `New DM${newMessages.length > 1 ? 's' : ''} from ${senders}. Latest: "${firstMsg.preview}" — Read DMs and respond.`;

  console.log(`[dm-poller] Firing DM wake: ${purpose}`);
  state.last_wake_fired = new Date().toISOString();
  await writeState(state);

  // Fire the wake (non-blocking)
  fireWake('dm', purpose).catch(err => {
    console.error(`[dm-poller] Wake fire failed: ${err.message}`);
  });
}

/**
 * Start the DM poller. Requires a fireWake(label, purpose) callback.
 */
export function startDMPoller(fireWake) {
  console.log(`[dm-poller] Starting (${POLL_INTERVAL_MS / 1000 / 60}-minute interval)`);

  // Initial poll after 30s (give bot time to fully start)
  setTimeout(() => {
    pollDMs(fireWake).catch(err => console.error(`[dm-poller] Poll error: ${err.message}`));
  }, 30 * 1000);

  setInterval(() => {
    pollDMs(fireWake).catch(err => console.error(`[dm-poller] Poll error: ${err.message}`));
  }, POLL_INTERVAL_MS);
}
