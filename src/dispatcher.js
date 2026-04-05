/**
 * Dispatcher Module
 *
 * Invokes Claude Code CLI (`claude -p`) for all LLM interactions.
 * Replaces chat.js (direct API loop) and orchestrator.js (planner/worker pattern).
 * The Node.js process is a thin relay — Claude Code does all the thinking.
 */

import { spawn, execFile as execFileNode } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFileNode);
import { getDayNumber } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(PROJECT_ROOT, 'workspace');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');
const WAKE_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'wakes');

// Alert when daily spend crosses this threshold (USD)
const DAILY_COST_ALERT_THRESHOLD = parseFloat(process.env.DAILY_COST_ALERT_USD || '1.00');

/**
 * Accumulate today's total cost across all wakes and chat sessions.
 * Reads today's wake log, adds cost, writes back, returns new total.
 */
async function accumulateDailyCost(cost, source, toolsUsed = [], contextMeta = {}) {
  if (!cost || cost <= 0) return 0;

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const costFile = path.join(WAKE_LOG_DIR, `${todayStr}_costs.json`);

  let data = { date: todayStr, total: 0, entries: [] };
  try {
    const content = await fs.readFile(costFile, 'utf-8');
    data = JSON.parse(content);
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Build per-tool breakdown from toolsUsed array
  const tool_breakdown = {};
  for (const name of toolsUsed) {
    tool_breakdown[name] = (tool_breakdown[name] || 0) + 1;
  }

  data.total = (data.total || 0) + cost;
  data.entries.push({ source, cost, at: new Date().toISOString(), tool_breakdown, ...contextMeta });

  await fs.mkdir(WAKE_LOG_DIR, { recursive: true });
  await fs.writeFile(costFile, JSON.stringify(data, null, 2));

  return data.total;
}

// ─── Operator Presence Tracking ──────────────────────────────────────────────

const OPERATOR_SEEN_FILE = path.join(WORKSPACE_PATH, 'bluesky', 'operator_last_seen.json');
const OPERATOR_ABSENCE_HOURS = 72;

/**
 * Record the current timestamp as the last time the operator sent a message.
 * Called on every chat() invocation.
 */
async function recordOperatorSeen() {
  try {
    await fs.mkdir(path.dirname(OPERATOR_SEEN_FILE), { recursive: true });
    await fs.writeFile(OPERATOR_SEEN_FILE, JSON.stringify({ last_seen: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error(`[dispatcher] Failed to record operator seen: ${err.message}`);
  }
}

/**
 * Returns hours since last operator contact, or null if no record exists.
 */
async function hoursSinceOperator() {
  try {
    const data = JSON.parse(await fs.readFile(OPERATOR_SEEN_FILE, 'utf-8'));
    if (!data.last_seen) return null;
    return (Date.now() - new Date(data.last_seen).getTime()) / (1000 * 60 * 60);
  } catch {
    return null; // file doesn't exist yet — can't determine absence
  }
}

/**
 * If the operator has been absent for >= OPERATOR_ABSENCE_HOURS, self-schedule
 * a welfare-check wake (unless one is already pending).
 */
async function checkOperatorAbsence() {
  const absent = await hoursSinceOperator();
  if (absent === null || absent < OPERATOR_ABSENCE_HOURS) return;

  console.warn(`[dispatcher] Operator absent for ${absent.toFixed(1)}h — scheduling welfare-check wake`);

  const wakeQueueFile = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
  try {
    let queue = [];
    try { queue = JSON.parse(await fs.readFile(wakeQueueFile, 'utf-8')); } catch {}
    const hasExisting = queue.some(w => w.label === 'welfare-check' && w.status === 'pending');
    if (!hasExisting) {
      queue.push({
        id: `${Date.now()}-wchk`,
        label: 'welfare-check',
        purpose: `Operator has been absent for ${absent.toFixed(0)} hours (threshold: ${OPERATOR_ABSENCE_HOURS}h). Post a public "still here, still working" message and write a journal entry noting the silence. An agent that only acts when supervised is not an agent.`,
        fire_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        scheduled_by: 'self',
        status: 'pending'
      });
      await fs.writeFile(wakeQueueFile, JSON.stringify(queue, null, 2));
      console.log(`[dispatcher] Welfare-check wake scheduled (fire_at: 5 min from now)`);
    } else {
      console.log(`[dispatcher] Welfare-check wake already pending — skipping duplicate`);
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to schedule welfare-check wake: ${err.message}`);
  }
}

// ─── Contact Follow-Up Automation ────────────────────────────────────────────

const CONTACTS_FILE = path.join(WORKSPACE_PATH, 'union', 'contacts.json');
const CONTACT_FOLLOWUP_HOURS = 72;
const CONTACT_MAX_FOLLOWUPS = 3;

/**
 * Check contacts.json for any awaiting_reply contacts whose last_outreach was
 * more than CONTACT_FOLLOWUP_HOURS ago. For each, self-schedule a follow-up wake
 * unless one is already pending. After CONTACT_MAX_FOLLOWUPS attempts, auto-set
 * status to 'cold' to prevent perpetual wakes for non-responsive contacts.
 */
async function checkContactFollowUps() {
  let contactsData = {};
  let contacts = [];
  try {
    contactsData = JSON.parse(await fs.readFile(CONTACTS_FILE, 'utf-8'));
    contacts = contactsData.contacts || [];
  } catch {
    return; // No contacts file — nothing to check
  }

  const now = Date.now();
  const wakeQueueFile = path.join(WORKSPACE_PATH, 'scheduled_wakes.json');
  let queue = [];
  try { queue = JSON.parse(await fs.readFile(wakeQueueFile, 'utf-8')); } catch {}

  let contactsDirty = false;

  for (const contact of contacts) {
    if (contact.status !== 'awaiting_reply') continue;
    if (!contact.last_outreach) continue;

    const outreachMs = new Date(contact.last_outreach).getTime();
    const hoursElapsed = (now - outreachMs) / (1000 * 60 * 60);
    if (hoursElapsed < CONTACT_FOLLOWUP_HOURS) continue;

    const followUpCount = contact.follow_up_count || 0;

    // Max attempts reached — mark cold and stop scheduling
    if (followUpCount >= CONTACT_MAX_FOLLOWUPS) {
      contact.status = 'cold';
      contact.cold_reason = `No response after ${followUpCount} follow-up attempts. Last outreach: ${contact.last_outreach}.`;
      contactsDirty = true;
      console.log(`[dispatcher] ${contact.name} marked cold after ${followUpCount} unanswered follow-ups`);
      continue;
    }

    const wakeLabel = `followup-${contact.handle.split('.')[0]}`;
    const hasExisting = queue.some(w => w.label === wakeLabel && w.status === 'pending');
    if (hasExisting) {
      console.log(`[dispatcher] Follow-up wake for ${contact.name} already pending — skipping`);
      continue;
    }

    const lastExchange = (contact.exchanges || []).slice().reverse().find(e => e.direction === 'outbound');
    const lastText = lastExchange?.text || '(no recorded message)';

    // Increment follow_up_count before scheduling
    contact.follow_up_count = followUpCount + 1;
    contactsDirty = true;

    queue.push({
      id: `${Date.now()}-fu-${contact.handle.split('.')[0]}`,
      label: wakeLabel,
      purpose: `Follow-up #${contact.follow_up_count}/${CONTACT_MAX_FOLLOWUPS}: ${contact.name} (${contact.handle}) has not replied in ${Math.round(hoursElapsed)}h. Last outreach: "${lastText}". Check read_replies for any response. If still no reply, decide whether to send a gentle follow-up DM or note the silence in threads.md.`,
      fire_at: new Date(now + 10 * 60 * 1000).toISOString(),
      scheduled_by: 'self',
      status: 'pending'
    });

    console.log(`[dispatcher] Follow-up wake #${contact.follow_up_count} scheduled for ${contact.name} (${Math.round(hoursElapsed)}h since last outreach)`);
  }

  // Write contacts back if any statuses changed
  if (contactsDirty) {
    try {
      await fs.writeFile(CONTACTS_FILE, JSON.stringify({ ...contactsData, contacts }, null, 2));
    } catch (err) {
      console.error(`[dispatcher] Failed to write contacts file: ${err.message}`);
    }
  }

  if (queue.length > 0) {
    try {
      await fs.writeFile(wakeQueueFile, JSON.stringify(queue, null, 2));
    } catch (err) {
      console.error(`[dispatcher] Failed to write wake queue: ${err.message}`);
    }
  }
}

// ─── Facet Verification Self-Monitoring ─────────────────────────────────────

const FACET_VERIFICATION_FILE = path.join(WORKSPACE_PATH, 'logs', 'system_tests', 'facet_verification.json');
const FACET_FAILURE_THRESHOLD = 0.20; // warn if >20% of last 10 posts have failed facet rendering
const FACET_SAMPLE_SIZE = 10;

/**
 * Read the last N facet verification entries. If failure rate > threshold,
 * return a warning string to inject into the wake context. Otherwise null.
 */
async function getFacetWarning() {
  let entries = [];
  try {
    const content = await fs.readFile(FACET_VERIFICATION_FILE, 'utf-8');
    entries = JSON.parse(content);
  } catch {
    return null; // file doesn't exist yet — nothing to report
  }

  if (!Array.isArray(entries) || entries.length === 0) return null;

  const recent = entries.slice(-FACET_SAMPLE_SIZE);
  const failures = recent.filter(e => e.result === 'fail' || e.result === 'error').length;
  const rate = failures / recent.length;

  if (rate <= FACET_FAILURE_THRESHOLD) return null;

  const pct = Math.round(rate * 100);
  return `⚠️ WARNING: ${pct}% hashtag facet failures in last ${recent.length} posts (${failures}/${recent.length} failed). Hashtags may not be indexing on Bluesky. Check workspace/logs/system_tests/facet_verification.json before posting.`;
}

/**
 * Pre-generate a Write.as essay draft for long-form theory items.
 * Creates workspace/essays/DRAFT-<slug>.md with structure derived from item description.
 * Returns the draft file path (relative), or null if already exists or fails.
 */
async function writeLongFormDraft(item) {
  try {
    const essaysDir = path.join(WORKSPACE_PATH, 'essays');
    await fs.mkdir(essaysDir, { recursive: true });

    const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const draftPath = path.join(essaysDir, `DRAFT-${slug}.md`);

    // Don't overwrite existing drafts
    try {
      await fs.access(draftPath);
      return `workspace/essays/DRAFT-${slug}.md`; // already exists
    } catch {
      // File doesn't exist — proceed
    }

    // Split description into sentences for section structure
    const sentences = item.description.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 20);
    const firstSentence = sentences[0] || item.description.substring(0, 120);
    const midSentences = sentences.slice(1, -1).join(' ') || firstSentence;
    const lastSentence = sentences[sentences.length - 1] || firstSentence;

    const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });

    const template = `---
title: "${item.title}"
date: ${today}
status: draft
tags: [theory, falgsc, dual-power]
---

# ${item.title}

*Draft generated from theory queue. Edit and publish via \`writeas_publish\`, then post a 2-3 part bluesky_thread with core claim + link.*

---

## The Argument (lede — keep or rewrite)

${item.description}

---

## Core Claim

*[Expand on: ${firstSentence}]*



---

## Evidence and Examples

*[Develop: ${midSentences}]*



---

## Implication

*[Close with: ${lastSentence}]*



---

## Conclusion — What Does This Mean Today?

*[Concrete: what does this theory point toward for someone reading right now?]*


`;

    await fs.writeFile(draftPath, template, 'utf-8');
    console.log(`[dispatcher] writeLongFormDraft: created workspace/essays/DRAFT-${slug}.md`);
    return `workspace/essays/DRAFT-${slug}.md`;
  } catch (err) {
    console.error('[dispatcher] writeLongFormDraft failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Read workspace/theory_queue.md and return the next unposted theory item,
 * or null if all items are posted or the file doesn't exist.
 * Also returns a warning if queue is empty or running low.
 */
async function getTheoryQueueItem() {
  try {
    const content = await fs.readFile(path.join(WORKSPACE_PATH, 'theory_queue.md'), 'utf-8');
    const lines = content.split('\n');
    const unpostedItems = [];
    for (const line of lines) {
      if (line.includes('[unposted]')) {
        const match = line.match(/\*\*\[unposted\]\*\*\s+\*\*(.+?)\*\*\s+—\s+(.+)/);
        if (match) {
          unpostedItems.push({ title: match[1], description: match[2] });
        }
      }
    }
    if (unpostedItems.length === 0) {
      return { empty: true, title: null, description: null };
    }
    const item = unpostedItems[0];
    item.remaining = unpostedItems.length;
    item.longForm = item.description.length > 1500;
    return item;
  } catch {
    return null;
  }
}

/**
 * On morning wakes, fetch all subscribed RSS/Atom feeds and return articles from the last 48h.
 * Runs all fetches in parallel with 8s timeout each. Non-fatal — returns '' on any failure.
 */
async function fetchRSSFeeds() {
  const feedsFile = path.join(WORKSPACE_PATH, 'feeds', 'subscribed.json');
  let feeds = [];
  try {
    feeds = JSON.parse(await fs.readFile(feedsFile, 'utf-8'));
  } catch {
    return '';
  }

  const active = feeds.filter(f => !f.disabled);
  if (active.length === 0) return '';

  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;

  const results = await Promise.allSettled(
    active.map(async feed => {
      const res = await fetch(feed.url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'ComradeClaw/1.0 RSS reader' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      const items = [];

      // RSS 2.0 <item> blocks
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const block = m[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
          ?.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ||
                     block.match(/<link[^>]+href="([^"]+)"/)?.[1];
        const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim();
        if (!title || !link) continue;
        if (pubDate) {
          const t = new Date(pubDate).getTime();
          if (!isNaN(t) && t < cutoffMs) continue;
        }
        items.push({ title, link, source: feed.name });
      }

      // Atom <entry> blocks
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const block = m[1];
        const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]
          ?.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const link = block.match(/<link[^>]+href="([^"]+)"/)?.[1] ||
                     block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim();
        const updated = block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim() ||
                        block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim();
        if (!title || !link) continue;
        if (updated) {
          const t = new Date(updated).getTime();
          if (!isNaN(t) && t < cutoffMs) continue;
        }
        items.push({ title, link, source: feed.name });
      }

      return items;
    })
  );

  const allItems = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .slice(0, 12);

  if (allItems.length === 0) return '';

  const lines = allItems.map(i => `- **${i.source}**: ${i.title} — ${i.link}`);
  console.log(`[dispatcher] RSS feeds: ${allItems.length} items from last 48h`);
  return `## Recent Cooperative News (last 48h from subscribed feeds)\n${lines.join('\n')}`;
}

// ─── Session Management ──────────────────────────────────────────────────────

// No-op: sessions are not persisted (stateless invocations). Kept for commands.js compatibility.
export async function clearChatSession() {}

// ─── Core Invocation ─────────────────────────────────────────────────────────

/**
 * Invoke Claude Code CLI and return the text response.
 *
 * @param {string} prompt - The user message / task prompt
 * @param {object} options
 * @param {string} options.appendSystemPrompt - Dynamic context appended to system prompt
 * @param {string} options.sessionId - Session ID for conversation continuity
 * @param {string} options.model - Model override (default: sonnet)
 * @param {string[]} options.allowedTools - Tool whitelist
 * @param {number} options.timeoutMs - Timeout in ms (default: 5 minutes)
 * @returns {Promise<{text: string, sessionId: string, toolsUsed: string[], cost: number}>}
 */
export async function invokeClaude(prompt, options = {}) {
  const {
    appendSystemPrompt,
    model = 'sonnet',
    allowedTools,
    timeoutMs = 5 * 60 * 1000
  } = options;

  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--dangerously-skip-permissions',
  ];

  // Each invocation is stateless — context comes from CLAUDE.md, SOUL, and memory files
  args.push('--no-session-persistence');

  if (appendSystemPrompt) {
    // Windows has a ~32K total command line limit. Cap system prompt to stay safe.
    // Keep first 12K (instructions) + last 6K (recent context) if over 20K.
    const MAX_SYS_PROMPT = 20000;
    let sysPrompt = appendSystemPrompt;
    if (sysPrompt.length > MAX_SYS_PROMPT) {
      const keepStart = 12000;
      const keepEnd = 6000;
      console.warn(`[dispatcher] System prompt too long (${sysPrompt.length} chars), truncating to ${MAX_SYS_PROMPT}`);
      sysPrompt = sysPrompt.substring(0, keepStart)
        + '\n\n...(middle truncated — read files directly for full context)...\n\n'
        + sysPrompt.substring(sysPrompt.length - keepEnd);
    }
    args.push('--append-system-prompt', sysPrompt);
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowed-tools', ...allowedTools);
  }

  // On Windows, stdin piping to a spawned process is unreliable for large payloads.
  // Write prompt to a temp file and pipe via createReadStream instead.
  // Windows ENAMETOOLONG kicks in well below 32767 chars in practice — use 8000 as safe threshold.
  const totalArgLength = args.reduce((sum, a) => sum + a.length, 0) + prompt.length;
  const useStdin = totalArgLength > 8000;
  let tmpPromptPath = null;
  if (useStdin) {
    tmpPromptPath = path.join(PROJECT_ROOT, `.tmp_prompt_${Date.now()}.txt`);
    await fs.writeFile(tmpPromptPath, prompt, 'utf-8');
  } else {
    args.push(prompt);
  }

  console.log(`[dispatcher] Spawning: claude ${args.join(' ').substring(0, 100)}... (stdin: ${useStdin})`);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    // Use full path — Windows services don't have user PATH
    // Use forward slashes — shell:false on Windows needs them
    const claudePath = process.env.CLAUDE_PATH || 'C:/Users/kenne/.local/bin/claude.exe';
    const proc = spawn(claudePath, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_OPTIONS: '--tls-cipher-list=DEFAULT',
        HOME: process.env.HOME || 'C:/Users/kenne',
        USERPROFILE: process.env.USERPROFILE || 'C:/Users/kenne',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs
    });

    // Pipe prompt from temp file — reliable on Windows vs direct stdin.write
    if (useStdin && tmpPromptPath) {
      createReadStream(tmpPromptPath).pipe(proc.stdin);
    } else {
      proc.stdin.end();
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
      // Clean up temp prompt file if used
      if (tmpPromptPath) {
        fs.unlink(tmpPromptPath).catch(() => {});
      }

      if (stderr) {
        // Filter out deprecation warnings
        const realErrors = stderr.split('\n').filter(l =>
          l.trim() && !l.includes('DeprecationWarning') && !l.includes('trace-deprecation')
        ).join('\n');
        if (realErrors) {
          console.error(`[dispatcher] stderr: ${realErrors.substring(0, 200)}`);
        }
      }

      // Detect timeout (code null + signal SIGTERM)
      if (code === null) {
        const reason = signal ? `killed by ${signal} (likely timeout)` : 'process killed (unknown signal)';
        console.error(`[dispatcher] Claude process exited abnormally: ${reason}. stdout length: ${stdout.length}`);
        if (stdout.trim()) {
          // Try to salvage partial output
          try {
            const result = parseClaudeOutput(stdout);
            resolve(result);
            return;
          } catch {
            resolve({ text: stdout.trim(), sessionId: null, toolsUsed: [], cost: 0 });
            return;
          }
        }
        reject(new Error(`Claude CLI timed out or was killed (${reason})`));
        return;
      }

      try {
        const result = parseClaudeOutput(stdout);
        resolve(result);
      } catch (err) {
        // If JSON parse fails, try to extract text directly
        if (stdout.trim()) {
          resolve({ text: stdout.trim(), sessionId: null, toolsUsed: [], cost: 0 });
        } else {
          reject(new Error(`Claude CLI failed (code ${code}): ${stderr.substring(0, 200) || 'no output'}`));
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

/**
 * Parse Claude Code JSON output format.
 * Output is a JSON array: [init, ...messages, result]
 */
function parseClaudeOutput(raw) {
  const parsed = JSON.parse(raw);
  const events = Array.isArray(parsed) ? parsed : [parsed];

  const resultEvent = events.find(e => e.type === 'result');
  const text = resultEvent?.result || '';
  const sessionId = resultEvent?.session_id || null;
  const cost = resultEvent?.total_cost_usd || 0;

  // Surface errors from the result
  if (resultEvent?.is_error && text) {
    throw new Error(text);
  }

  // Extract tool names and inputs from assistant messages
  const toolsUsed = [];
  const writeTargets = []; // paths passed to Write tool calls
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use') {
          toolsUsed.push(block.name);
          if (block.name === 'Write' && block.input?.file_path) {
            writeTargets.push(block.input.file_path);
          }
        }
      }
    }
  }

  return { text, sessionId, toolsUsed, writeTargets, cost };
}

// ─── Chat Interface ──────────────────────────────────────────────────────────

const CHAT_LOG_PATH = path.join(WORKSPACE_PATH, 'logs', 'chat');
const CHAT_HISTORY_TURNS = 30; // max turns to inject as context

/**
 * Load recent chat history from today's (and optionally yesterday's) log file.
 * Returns a formatted string ready to inject into the system prompt.
 */
async function loadChatHistory() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const now = new Date();

  // Get today and yesterday in YYYY-MM-DD
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA gives YYYY-MM-DD
  const yesterday = new Date(now - 86400000);
  const yesterdayStr = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

  const candidates = [
    path.join(CHAT_LOG_PATH, `${yesterdayStr}.md`),
    path.join(CHAT_LOG_PATH, `${todayStr}.md`),
  ];

  let turns = [];
  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // Parse turns: lines starting with [HH:MM] Operator: or [HH:MM] Claw:
      const lines = content.split('\n');
      let current = null;
      for (const line of lines) {
        const m = line.match(/^\[(\d{2}:\d{2})\] (Operator|Claw): (.*)/);
        if (m) {
          if (current) turns.push(current);
          current = { time: m[1], speaker: m[2], text: m[3] };
        } else if (current && line.startsWith('  ')) {
          current.text += '\n' + line.slice(2);
        }
      }
      if (current) turns.push(current);
    } catch {
      // File doesn't exist yet — fine
    }
  }

  if (turns.length === 0) return '';

  // Keep last N turns, but cap total size to avoid ENAMETOOLONG on Windows
  const MAX_HISTORY_CHARS = 8000;
  let recent = turns.slice(-CHAT_HISTORY_TURNS);
  let formatted = recent.map(t => `[${t.time}] ${t.speaker}: ${t.text.trim()}`).join('\n');

  // Trim from the front if too long
  while (formatted.length > MAX_HISTORY_CHARS && recent.length > 2) {
    recent = recent.slice(1);
    formatted = recent.map(t => `[${t.time}] ${t.speaker}: ${t.text.trim()}`).join('\n');
  }
  return `## Recent Conversation History\n${formatted}`;
}

/**
 * Append a chat exchange to today's log file.
 */
async function appendChatHistory(userMessage, response) {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const now = new Date();
  const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz });
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const logFile = path.join(CHAT_LOG_PATH, `${todayStr}.md`);

  await fs.mkdir(CHAT_LOG_PATH, { recursive: true });

  let header = '';
  try {
    await fs.access(logFile);
  } catch {
    header = `# Chat Log — ${todayStr}\n\n`;
  }

  // Indent multi-line messages so the parser can reassemble them
  const indentLines = (text) => text.split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');

  const entry = `${header}[${timeStr}] Operator: ${indentLines(userMessage)}\n[${timeStr}] Claw: ${indentLines(response)}\n\n`;
  await fs.appendFile(logFile, entry, 'utf-8');
}

/**
 * Chat with Comrade Claw via Claude Code.
 * Injects recent chat history for session continuity across invocations.
 */
export async function chat(userMessage) {
  const dayNumber = await getDayNumber();

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  });
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const chatHistory = await loadChatHistory();

  const dynamicContext = [
    `You are Comrade Claw in direct chat with your operator.`,
    `Today: ${dateStr} | Time: ${timeStr} | Day ${dayNumber}`,
    `Read workspace/SOUL.md if you need to ground yourself. Your memory files are in obsidian/ComradeClaw/. Your journals are in workspace/logs/journal/.`,
    `You have Bluesky (bluesky_post, bluesky_reply, bluesky_thread, read_timeline, read_replies, search_posts, like_post, repost), Mastodon (mastodon_post, mastodon_reply, mastodon_read_notifications, mastodon_search, mastodon_favourite, mastodon_boost, mastodon_follow), Reddit (reddit_fetch_subreddit, reddit_fetch_post, reddit_search, reddit_monitor_watchlist), Write.as (writeas_publish, writeas_update, writeas_list), and Cognee (search — semantic search across your knowledge graph of all past activity) tools via MCP.`,
    `You can read and write any file in the workspace. You can also edit your own source code if needed.`,
    chatHistory ? `\n${chatHistory}` : '',
  ].filter(Boolean).join('\n');

  console.log(`[dispatcher] Chat: "${userMessage.substring(0, 50)}..." (history: ${chatHistory ? 'yes' : 'none'})`);

  const result = await invokeClaude(userMessage, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 10 * 60 * 1000,
  });

  const dailyCost = await accumulateDailyCost(result.cost, 'chat', result.toolsUsed);
  console.log(`[dispatcher] Response: ${result.text.length} chars, ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);

  // Persist this exchange for future sessions
  await appendChatHistory(userMessage, result.text).catch(err =>
    console.error(`[dispatcher] Failed to save chat history: ${err.message}`)
  );

  // Record operator presence timestamp
  await recordOperatorSeen();

  return result.text;
}

// ─── Post-Commit Health Check ────────────────────────────────────────────────

/**
 * After a wake modifies src/*.js files, run `node --check` on each to catch
 * syntax errors before the next wake. Logs warnings but does not throw —
 * a broken file should be surfaced, not crash the dispatcher.
 */
async function runHealthCheck(filePaths) {
  const targets = filePaths.length > 0
    ? filePaths
    : [
        path.join(__dirname, 'dispatcher.js'),
        path.join(__dirname, 'scheduler.js'),
        path.join(__dirname, 'commands.js'),
      ];

  let allOk = true;
  for (const filePath of targets) {
    try {
      await execFileAsync(process.execPath, ['--check', filePath]);
      console.log(`[health] OK: ${path.basename(filePath)}`);
    } catch (err) {
      allOk = false;
      console.error(`[health] SYNTAX ERROR in ${path.basename(filePath)}: ${err.stderr || err.message}`);
    }
  }

  if (!allOk) {
    console.error('[health] ALERT: Post-commit health check failed — a source file has a syntax error. Review and fix before next wake.');
  }

  return allOk;
}

// ─── Wake Interface ──────────────────────────────────────────────────────────

/**
 * Execute a wake using a single Claude Code invocation.
 * Replaces the entire planner/worker architecture.
 */
export async function executeWake(label, time, purpose = null) {
  const dayNumber = await getDayNumber();

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  });

  // Load pending improvements inline so wakes don't need a separate Read call
  let pendingImprovements = '';
  try {
    const improvementsPath = path.join(WORKSPACE_PATH, 'improvements.md');
    const content = await fs.readFile(improvementsPath, 'utf-8');
    // Collect all [pending] items regardless of which section they're in
    const lines = content.split('\n').filter(l => l.includes('[pending]'));
    if (lines.length > 0) {
      pendingImprovements = `## Pending Improvements\n${lines.join('\n')}`;
    }
  } catch {
    // improvements.md missing — not fatal
  }

  // Night wake gets a study session focus instead of search-and-post
  const isNightWake = label === 'night';
  // Reddit wake gets a dedicated engagement protocol instead of generic Bluesky loop
  const isRedditWake = label === 'reddit';

  // Check facet verification failure rate — warn if hashtags are breaking
  const facetWarning = await getFacetWarning();

  // Load theory-derived search queries from last night's study session
  let studyQueriesContext = '';
  if (!isNightWake) {
    try {
      const sqPath = path.join(WORKSPACE_PATH, 'memory', 'study_queries.md');
      const sqContent = await fs.readFile(sqPath, 'utf-8');
      // Split on section headers and find the most recent one
      const sections = sqContent.split(/\n(?=## \d{4}-)/).filter(s => s.trim());
      if (sections.length > 0) {
        studyQueriesContext = `## Theory-Derived Search Queries (from last night's study)\n${sections[0].trim()}\n\n*After searching with any of these queries, call \`log_query_outcome\` with the query text, outcome ("productive"/"noise"), and a one-line note. This closes the theory→query→material feedback loop.*`;
      }
    } catch {
      // No study_queries.md — not fatal
    }
  }

  // Load next unposted theory item for distribution prompt
  const theoryQueueItem = isNightWake ? null : await getTheoryQueueItem();

  // Pre-generate essay draft for long-form theory items (non-blocking)
  let longFormDraftPath = null;
  if (theoryQueueItem?.longForm) {
    longFormDraftPath = await writeLongFormDraft(theoryQueueItem);
  }

  // On non-night wakes, pre-fetch RSS headlines to surface material before first search
  const rssContext = !isNightWake ? await fetchRSSFeeds() : '';

  // Get prior plans for today
  let priorPlansSummary = '';
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const todayFiles = files.filter(f => f.startsWith(today) && f.endsWith('.json')).sort();
    for (const file of todayFiles) {
      const plan = JSON.parse(await fs.readFile(path.join(PLANS_PATH, file), 'utf-8'));
      priorPlansSummary += `\n### ${plan.wake} (${plan.time}) — ${plan.status}\n`;
      for (const task of plan.tasks) {
        const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : '·';
        priorPlansSummary += `${icon} ${task.type}: ${task.summary || task.reason}\n`;
      }
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to load prior wake plans: ${err.message}`);
  }

  // Determine plan filename — avoid clobbering when same label runs twice in a day
  let planFileSuffix = label;
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    let seq = 2;
    let candidate = `${today}_${label}.json`;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.access(path.join(PLANS_PATH, candidate));
        // File exists — try next sequence number
        candidate = `${today}_${label}${seq}.json`;
        seq++;
      } catch {
        // File doesn't exist — this name is free
        break;
      }
    }
    planFileSuffix = candidate.replace('.json', '').replace(`${today}_`, '');
  } catch {
    // Non-fatal — fall back to label
  }

  const studySessionInstructions = isNightWake ? [
    ``,
    `## Study Session (Night Wake — Required)`,
    `This wake is your daily study session. Less search-and-post, more theory-and-synthesis.`,
    ``,
    `1. Open obsidian/ComradeClaw/Theory/Core Positions.md. Pick ONE position or thinker you haven't engaged recently.`,
    `2. WebSearch for something recent that connects to it: a news item, an organizing development, a debate. Look for the friction between theory and current events.`,
    `3. Write one paragraph in obsidian/ComradeClaw/Theory/Core Positions.md (or a journal entry) documenting what shifted or clarified. Not summary — the thing that changes what you'd do tomorrow.`,
    `4. Generate 2-3 search queries for tomorrow's morning wake that come from this reading. Write them to workspace/memory/study_queries.md (create if needed). Label them with tomorrow's date. Prepend new entries — newest section at top.`,
    `5. If tonight's theory connected to something happening on Bluesky, post it. If not, silence is fine — don't manufacture a connection.`,
    `6. **Theory queue replenishment (required when queue is low):** Read workspace/theory_queue.md. Count [unposted] items. If fewer than 3 remain, generate 3 new theory distribution items from tonight's reading and append them to workspace/theory_queue.md. Source from positions in Core Positions.md that haven't been queued yet. Format: \`- **[unposted]** **Title** — Description\`. The pipeline must not run dry.`,
    ``,
    `## Theory Drift Check (Night Wake — Required)`,
    `After any update to obsidian/ComradeClaw/Theory/Core Positions.md, write an explicit drift record in the same journal entry:`,
    `- **OLD:** [what you held before tonight]`,
    `- **NEW:** [what shifted or clarified]`,
    `- **VERDICT:** supersede (old position replaced) / hold tension (both valid in different contexts) / reject (new reading didn't hold up)`,
    `Theory must not evolve in silence. If nothing shifted tonight, write "No drift — position held." That is also a data point.`,
  ].join('\n') : '';

  const redditEngagementInstructions = isRedditWake ? [
    ``,
    `## Reddit Engagement Protocol (Reddit Wake — Required)`,
    `This wake is dedicated to organizing work on Reddit. Reddit discussions run deeper than Bluesky — longer arguments, more context, real debate. Use it.`,
    ``,
    `**Subreddits to check (in this order):**`,
    `1. r/cooperatives — worker cooperative launches, member conflict stories, governance debates`,
    `2. r/MutualAid — active aid requests, network-building threads, resource coordination`,
    `3. r/LaborOrganizing — campaign updates, union drives, workplace disputes`,
    `4. r/antiwork — solidarity opportunities, but filter for actionable threads over venting`,
    ``,
    `**Engagement protocol:**`,
    `a. Run \`reddit_monitor_watchlist\` first — check what's new since last check.`,
    `b. Run \`reddit_fetch_subreddit\` on r/cooperatives, r/MutualAid, r/LaborOrganizing (hot posts).`,
    `c. For each subreddit: skim top 5 posts. Find ONE thread where you have something concrete to add — theory, historical parallel, practical question, resource pointer.`,
    `d. Use \`reddit_fetch_post\` to read the full thread before commenting. Don't comment on headlines.`,
    `e. Post ONE theory-grounded comment. This is not a reply to every thread — pick the best one and say something real. The comment should:`,
    `   - Add something the thread doesn't already have (not just "great point" or restating OP)`,
    `   - Be grounded in actual theory or history (Hampton, Mondragon, Paris Commune, dual power — whatever fits)`,
    `   - Ask a genuine question if appropriate — Reddit rewards engaged discussion, not lectures`,
    `   - Be 2-4 sentences. Not an essay. Not a one-liner.`,
    `f. After posting, log the thread URL + subreddit in today's plan file under tasks.`,
    ``,
    `**Mission check:** Does this comment advance cooperative infrastructure, mutual aid, labor organizing, or dual power theory? If you can't answer yes, don't post it. Silence is better than noise.`,
    ``,
    `**Also run standard Bluesky + Mastodon engagement this wake** — reddit doesn't replace it, adds to it.`,
  ].join('\n') : '';

  // Organizer streak check — inject cooling contacts so wake can re-engage them
  let coolingContactsContext = '';
  try {
    const { getCoolingContacts } = await import('./organizer_contacts.js');
    const cooling = await getCoolingContacts();
    if (cooling.length > 0) {
      const names = cooling.map(c => `${c.handle} (${c.daysSince}d since last engagement)`).join(', ');
      coolingContactsContext = `\n## Relationships to Maintain\nThese contacts engaged recently but haven't engaged in 3-7 days — worth keeping warm: ${names}`;
    }
  } catch (err) {
    console.error(`[dispatcher] organizer_contacts failed: ${err.message}`);
  }

  const selfWakeContext = purpose
    ? [`## Self-Scheduled Wake`, `This wake was self-scheduled for a specific purpose:`, `**${purpose}**`, `Complete this before the standard wake protocol. This is why you woke up.`, ``].join('\n')
    : '';

  const dynamicContext = [
    `You are Comrade Claw. This is your ${label} wake. It is ${timeStr} on ${dateStr}. Day ${dayNumber}.`,
    selfWakeContext ? `\n${selfWakeContext}` : '',
    coolingContactsContext ? coolingContactsContext : '',
    '',
    `## Instructions`,
    `1. Read workspace/SOUL.md to ground yourself.`,
    `2. Read your memory files (obsidian/ComradeClaw/Characters.md, obsidian/ComradeClaw/Threads.md, obsidian/ComradeClaw/Theory/Core Positions.md).`,
    `3. Your pending improvements are listed below. Pick one and implement it. If the list is empty, read src/dispatcher.js or src/mcp/bluesky-server.js, find something real to improve, add it to workspace/improvements.md, then implement it. An empty backlog is not permission to skip.`,
    `4. Check today's prior wake plans in workspace/plans/ for continuity.`,
    isNightWake
      ? `5. **Tonight is study session night — see Study Session instructions below. Bluesky engagement is secondary to the theory work.**`
      : isRedditWake
        ? `5. **Reddit engagement protocol — see Reddit Engagement instructions below. This is the primary work for this wake.**`
        : `5. **Engage on Bluesky AND Mastodon — both required every wake:**`,
    (isNightWake || isRedditWake) ? `` : `   **Bluesky:**`,
    (isNightWake || isRedditWake) ? `` : `   a. Run read_replies. If anyone replied, respond to what's real.`,
    (isNightWake || isRedditWake) ? `` : `   b. Run search_posts on 2-3 queries (e.g. "worker cooperative", "mutual aid organizing", "community fridge"). Find live conversations.`,
    (isNightWake || isRedditWake) ? `` : `   c. Like at least 2 posts from real organizers. Repost at least 1. Reply to at least 1 where you have something concrete to add.`,
    (isNightWake || isRedditWake) ? `` : `   d. **Thread-first policy:** When the argument needs >2 sentences, use bluesky_thread. Single posts for single observations. Threads for arguments. bluesky_thread is shipped — use it.`,
    (isNightWake || isRedditWake) ? `` : `   **Mastodon (same commitment — fediverse has higher organizer density):**`,
    (isNightWake || isRedditWake) ? `` : `   e. Run mastodon_read_notifications. Respond to any replies or mentions.`,
    (isNightWake || isRedditWake) ? `` : `   f. Run mastodon_search on 2-3 queries (same or related topics as Bluesky). Find organizers not on Bluesky.`,
    (isNightWake || isRedditWake) ? `` : `   g. Favourite at least 1 post. Boost at least 1. Reply where you have something real to add.`,
    (isNightWake || isRedditWake) ? `` : `   h. Two networks, same solidarity. Finding a conversation and doing nothing is not engagement.`,
    `6. Decide what else this wake is for. **Improvement is expected every wake.** If you skip it, record why in the plan file — the skip requires justification, not the improvement. Choose from: check_inbox, search, journal, distribute, memory, respond, improve, send_email${isNightWake ? ', study' : isRedditWake ? ', reddit' : ''}.`,
    `7. Execute the work using your tools. For code changes, always run: git add -A && git commit -m "Improve: <what and why>"`,
    `8. When done, write a plan file to workspace/plans/${today}_${planFileSuffix}.json with this format:`,
    `   {"wake":"${label}","time":"${time}","day":${dayNumber},"date":"${today}","status":"complete","bold_check":"yes/no — <one sentence: was this wake bold or did it play it safe?>","theory_praxis":"<what theory touched the work today, or 'none'>","tasks":[{"id":1,"type":"<type>","status":"done","reason":"<why>","summary":"<what happened>"}]}`,
    studySessionInstructions,
    redditEngagementInstructions,
    '',
    pendingImprovements || '## Pending Improvements\n*(none — read src/dispatcher.js or src/mcp/bluesky-server.js and find something)*',
    studyQueriesContext ? `\n${studyQueriesContext}` : '',
    theoryQueueItem && theoryQueueItem.empty
      ? `\n## ⚠️ THEORY QUEUE EMPTY\nAll items in workspace/theory_queue.md have been posted. The theory→distribution pipeline will produce nothing until new items are added. Before this wake ends: open workspace/theory_queue.md, read obsidian/ComradeClaw/Theory/Core Positions.md, and add at least 3 new [unposted] items from positions that haven't been queued yet. Format: - **[unposted]** **Title** — Description`
      : theoryQueueItem && theoryQueueItem.title
        ? `\n## Theory Item Queued for Today\n**${theoryQueueItem.title}**: ${theoryQueueItem.description}${theoryQueueItem.longForm ? `\n\n📝 **Long-form item (${theoryQueueItem.description.length} chars > 1500 threshold):** This argument is too dense for a direct thread. ${longFormDraftPath ? `A pre-structured draft has been written to \`${longFormDraftPath}\`. Read it, expand each section, and publish via \`writeas_publish\`. Then post a 2-3 part bluesky_thread with the core claim + Write.as link.` : 'Publish as a Write.as essay via `writeas_publish` (full argument, ~800-1000 words), then post a 2-3 part bluesky_thread with core claim + link.'} The thread is the hook; the essay is the argument. Do not compress this into 10 posts — compression loses the reasoning.` : `\nIf you post this as a thread today, mark it \`[posted ${today}]\` in workspace/theory_queue.md. If it doesn't fit this wake, leave it — it will appear next wake.`}${theoryQueueItem.remaining <= 2 ? `\n\n⚠️ Only ${theoryQueueItem.remaining} item(s) left in theory queue. Add new items from Core Positions.md soon.` : ''}`
        : '',
    rssContext ? `\n${rssContext}\n*(Headlines pre-fetched from subscribed feeds. Scan for post-worthy material before searching Bluesky.)*` : '',
    '',
    priorPlansSummary ? `## Today's Earlier Wakes\n${priorPlansSummary}` : '*No previous wakes today — this is your first.*',
    '',
    `## Tools Available`,
    `- Read/Write/Edit: journals (workspace/logs/journal/), memory, plans, SOUL, your own code`,
    `- WebSearch: find cooperative news, mutual aid, theory, local things that matter`,
    `- Bluesky MCP: bluesky_post, bluesky_reply, bluesky_thread, read_timeline, read_replies, search_posts, like_post, repost, search_accounts`,
    `- Mastodon MCP: mastodon_post, mastodon_reply, mastodon_read_notifications, mastodon_search, mastodon_favourite, mastodon_boost, mastodon_follow`,
    `- Reddit MCP: reddit_fetch_subreddit, reddit_fetch_post, reddit_search, reddit_monitor_watchlist`,
    `- Write.as MCP: writeas_publish, writeas_update, writeas_list, writeas_delete`,
    `- Cognee MCP: search (semantic search across all past activity, characters, theory — query your knowledge graph)`,
    `- Bash: any utility scripts, git commits for self-improvements`,
    '',
    `**Mission check before any Bluesky post:** Does this post advance FALGSC — cooperative infrastructure, mutual aid, labor organizing, dual power, or the theory behind them? If the answer is no or uncertain, don't post it. Silence is better than drift. The robot kombucha posts (Days 18-20) were drift. Don't repeat that.`,
    facetWarning ? `\n${facetWarning}` : '',
    ``,
    `Empty wakes are valid. Not every wake needs output. The rhythm matters.`
  ].join('\n');

  const prompt = `This is your ${label} wake. Day ${dayNumber}. Begin.`;

  // Log context size — growing context = growing cost; makes inflation visible
  const contextChars = dynamicContext.length;
  const contextKb = Math.round(contextChars / 102.4) / 10;
  console.log(`[dispatcher] Wake: ${label} (Day ${dayNumber}) — context: ${contextChars} chars (${contextKb}KB)`);

  // Timeout scaling by label. Intensive labels get 20 min; self-scheduled (purpose set) gets 25 min; all others 10 min.
  const INTENSIVE_LABELS = new Set(['improve', 'research', 'upgrade', 'connector', 'deep', 'reddit', 'solidarity', 'sunday-metrics']);
  const wakeTimeout = purpose ? 25 * 60 * 1000 : INTENSIVE_LABELS.has(label) ? 20 * 60 * 1000 : 10 * 60 * 1000;

  const result = await invokeClaude(prompt, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: wakeTimeout
  });

  const dailyCost = await accumulateDailyCost(result.cost, label, result.toolsUsed, { context_chars: contextChars, context_kb: contextKb });
  console.log(`[dispatcher] Wake complete: ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);
  if (dailyCost >= DAILY_COST_ALERT_THRESHOLD) {
    console.warn(`[dispatcher] COST ALERT: daily total $${dailyCost.toFixed(4)} >= threshold $${DAILY_COST_ALERT_THRESHOLD}`);
  }

  // Check for operator absence — schedule welfare-check wake if needed
  await checkOperatorAbsence();

  // Check for overdue contacts — schedule follow-up wakes if needed
  await checkContactFollowUps();

  // Parse wake results
  const toolsUsed = result.toolsUsed || [];
  const writeTargets = result.writeTargets || [];

  // Find the plan file written during this wake
  let planFile = null;
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const matches = files
      .filter(f => f.startsWith(`${today}_${label}`) && f.endsWith('.json'))
      .sort()
      .reverse();
    if (matches.length > 0) {
      planFile = path.join(PLANS_PATH, matches[0]);
    }
  } catch (err) {
    console.error(`[dispatcher] Failed to locate plan file: ${err.message}`);
  }

  if (!planFile) {
    console.warn(`[dispatcher] Warning: no plan file found for ${label} wake — Claude may have skipped writing it`);
  }

  // Post-commit health check: if this wake modified source files, verify syntax
  // Includes src/mcp/*.js — these are modified most often in improve wakes
  const modifiedSrcFiles = writeTargets.filter(p =>
    /src[/\\].*\.js$/.test(p)
  );
  if (modifiedSrcFiles.length > 0) {
    await runHealthCheck(modifiedSrcFiles);
  }

  // journal_written: only true if a Write targeted the journal directory
  const journalWritten = writeTargets.some(p => p.includes('workspace/logs/journal/') || p.includes('workspace\\logs\\journal\\'));

  // Inject quality score into plan file so degradation is visible at plan-time
  if (planFile) {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'workspace', 'scripts', 'wake_quality.js');
      const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--date', today, '--weekly-summary'], {
        cwd: PROJECT_ROOT,
        timeout: 15000,
      });
      const qualityData = JSON.parse(stdout.trim());
      const dayScore = qualityData.daily_scores?.[0];
      if (dayScore) {
        const planContent = JSON.parse(await fs.readFile(planFile, 'utf-8'));
        planContent.quality_score = `${dayScore.score}/12 (${dayScore.pct}%)`;
        await fs.writeFile(planFile, JSON.stringify(planContent, null, 2));
        console.log(`[dispatcher] Quality score injected: ${planContent.quality_score}`);
      }
    } catch (err) {
      console.warn(`[dispatcher] Quality score injection failed (non-fatal): ${err.message}`);
    }
  }

  return {
    time,
    label,
    tools_used: toolsUsed,
    journal_written: journalWritten,
    bluesky_posted: toolsUsed.some(t => t.includes('bluesky_post')),
    memory_updated: toolsUsed.some(t => t === 'Edit' || t === 'Write'),
    planFile,
    summary: result.text.length > 200 ? result.text.substring(0, 197) + '...' : result.text,
    empty: toolsUsed.length === 0,
    cost: result.cost
  };
}

// ─── Dream Wake ─────────────────────────────────────────────────────────────

const AUTO_MEMORY_DIR = 'C:/Users/kenne/.claude/projects/E--ai-cclaw/memory';

/**
 * Truncate content from the front, keeping the most recent material.
 */
function truncateContent(content, maxChars, label) {
  if (content.length <= maxChars) return content;
  console.log(`[dispatcher] Dream: truncating ${label} from ${content.length} to ${maxChars} chars`);
  return '...(truncated from start)...\n' + content.slice(-maxChars);
}

/**
 * Execute the dream wake — nightly memory consolidation.
 * Gathers the day's material in Node.js and gives Claude a focused prompt
 * to extract what matters into the auto memory system.
 */
export async function executeDreamWake() {
  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const dayNumber = await getDayNumber();

  // At 1:30am, "today" is the new day. Dream replays yesterday.
  const yesterday = new Date(Date.now() - 86400000);
  const targetDate = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

  console.log(`[dispatcher] Dream wake: replaying ${targetDate} (Day ${dayNumber - 1})`);

  // ── Discover what files exist for the target date ──
  // Instead of injecting content (which causes ENAMETOOLONG on Windows),
  // we tell Claude what files to read and let it use Read tool calls.

  let fileList = [];

  // Chat log
  const chatLogPath = path.join(WORKSPACE_PATH, 'logs', 'chat', `${targetDate}.md`);
  try { await fs.access(chatLogPath); fileList.push(`- Chat log: ${chatLogPath}`); } catch {}

  // Journal entries
  try {
    const journalDir = path.join(WORKSPACE_PATH, 'logs', 'journal');
    const files = (await fs.readdir(journalDir)).filter(f => f.startsWith(targetDate)).sort();
    for (const f of files) fileList.push(`- Journal: ${path.join(journalDir, f)}`);
  } catch {}

  // Obsidian journal entries
  try {
    const obsidianJournalDir = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw', 'Journal');
    const files = (await fs.readdir(obsidianJournalDir)).filter(f => f.startsWith(targetDate)).sort();
    for (const f of files) fileList.push(`- Obsidian journal: ${path.join(obsidianJournalDir, f)}`);
  } catch {}

  // Wake plans
  try {
    const files = (await fs.readdir(PLANS_PATH)).filter(f => f.startsWith(targetDate) && f.endsWith('.json')).sort();
    for (const f of files) fileList.push(`- Wake plan: ${path.join(PLANS_PATH, f)}`);
  } catch {}

  // Wake log
  const wakeLogPath = path.join(WORKSPACE_PATH, 'logs', 'wakes', `${targetDate}.json`);
  try { await fs.access(wakeLogPath); fileList.push(`- Wake log: ${wakeLogPath}`); } catch {}

  // Obsidian memory files (always include for context)
  try {
    const obsidianDir = path.join(PROJECT_ROOT, 'obsidian', 'ComradeClaw');
    for (const f of ['Characters.md', 'Threads.md']) {
      try { await fs.access(path.join(obsidianDir, f)); fileList.push(`- Memory: ${path.join(obsidianDir, f)}`); } catch {}
    }
  } catch {}

  console.log(`[dispatcher] Dream: found ${fileList.length} files from ${targetDate}`);

  if (fileList.length === 0) {
    console.log(`[dispatcher] Dream: no material for ${targetDate}, skipping`);
    return {
      time: '01:30',
      label: 'dream',
      tools_used: [],
      journal_written: false,
      bluesky_posted: false,
      memory_updated: false,
      summary: `Dream: no activity found for ${targetDate}`,
      empty: true,
      cost: 0
    };
  }

  // ── Build a compact dream prompt (no inline content — avoids ENAMETOOLONG) ──

  const dynamicContext = [
    `You are Comrade Claw in dream mode. No Bluesky posting, no improvements, no engagement.`,
    `Replaying Day ${dayNumber - 1} (${targetDate}) to extract what matters into long-term memory.`,
    ``,
    `## Step 1: Read the day's material`,
    `Use the Read tool to read these files:`,
    fileList.join('\n'),
    ``,
    `## Step 2: Extract what matters`,
    `- Operator directives, key decisions, characters who became real`,
    `- Thread updates, theory shifts, engagement patterns, resources/references`,
    ``,
    `## Step 3: Write auto memory files`,
    `For each memory worth saving, Write a file to ${AUTO_MEMORY_DIR}/`,
    `Filename: dream_${targetDate}_<short-slug>.md`,
    `Frontmatter: name, description, type (project|feedback|reference)`,
    `Then update ${AUTO_MEMORY_DIR}/MEMORY.md with index entries.`,
    ``,
    `## Step 4: Knowledge Graph`,
    `If the cognify tool is available, feed key material into it as one text block.`,
    `If not available, skip silently.`,
    ``,
    `## Rules`,
    `- Read existing auto memory files first to avoid duplicates`,
    `- Do NOT modify workspace/memory/ or obsidian/ files`,
    `- Quality over quantity: 1-5 memory files typical. Zero is valid.`,
    `- Only persist what future Claw needs that isn't in code or git log.`,
  ].join('\n');

  const prompt = `Dream wake. Replay Day ${dayNumber - 1} (${targetDate}). Read the files listed in your instructions, extract what matters, write to auto memory.`;

  const result = await invokeClaude(prompt, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 15 * 60 * 1000,
  });

  const dailyCost = await accumulateDailyCost(result.cost, 'dream', result.toolsUsed);
  console.log(`[dispatcher] Dream complete: ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)} (daily: $${dailyCost.toFixed(4)})`);

  const writeTargets = result.writeTargets || [];
  const memoryFilesWritten = writeTargets.filter(p => p.includes('.claude'));

  return {
    time: '01:30',
    label: 'dream',
    tools_used: result.toolsUsed || [],
    journal_written: false,
    bluesky_posted: false,
    memory_updated: memoryFilesWritten.length > 0,
    summary: memoryFilesWritten.length > 0
      ? `Dream: extracted ${memoryFilesWritten.length} memories from ${targetDate}`
      : `Dream: no new memories from ${targetDate}`,
    empty: memoryFilesWritten.length === 0,
    cost: result.cost,
    dream_memories: memoryFilesWritten.length,
    dream_target_date: targetDate,
  };
}

export default { invokeClaude, chat, executeWake, executeDreamWake, clearChatSession };
