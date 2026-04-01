/**
 * Dispatcher Module
 *
 * Invokes Claude Code CLI (`claude -p`) for all LLM interactions.
 * Replaces chat.js (direct API loop) and orchestrator.js (planner/worker pattern).
 * The Node.js process is a thin relay — Claude Code does all the thinking.
 */

import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDayNumber } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(PROJECT_ROOT, 'workspace');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');
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
    args.push('--append-system-prompt', appendSystemPrompt);
  }

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowed-tools', ...allowedTools);
  }

  args.push(prompt);

  console.log(`[dispatcher] Spawning: claude ${args.join(' ').substring(0, 100)}...`);

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

    // Close stdin so claude doesn't wait for piped input
    proc.stdin.end();

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code, signal) => {
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

  // Keep last N turns
  const recent = turns.slice(-CHAT_HISTORY_TURNS);
  const formatted = recent.map(t => `[${t.time}] ${t.speaker}: ${t.text.trim()}`).join('\n');
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
    `Read workspace/SOUL.md if you need to ground yourself. Your memory files are in workspace/memory/. Your journals are in workspace/logs/journal/.`,
    `You have Bluesky tools via MCP (bluesky_post, bluesky_reply, read_timeline, read_replies).`,
    `You can read and write any file in the workspace. You can also edit your own source code if needed.`,
    chatHistory ? `\n${chatHistory}` : '',
  ].filter(Boolean).join('\n');

  console.log(`[dispatcher] Chat: "${userMessage.substring(0, 50)}..." (history: ${chatHistory ? 'yes' : 'none'})`);

  const result = await invokeClaude(userMessage, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 10 * 60 * 1000,
  });

  console.log(`[dispatcher] Response: ${result.text.length} chars, ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)}`);

  // Persist this exchange for future sessions
  await appendChatHistory(userMessage, result.text).catch(err =>
    console.error(`[dispatcher] Failed to save chat history: ${err.message}`)
  );

  return result.text;
}

// ─── Wake Interface ──────────────────────────────────────────────────────────

/**
 * Execute a wake using a single Claude Code invocation.
 * Replaces the entire planner/worker architecture.
 */
export async function executeWake(label, time) {
  const dayNumber = await getDayNumber();

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true
  });

  // Get prior plans for today
  let priorPlansSummary = '';
  try {
    const today = new Date().toISOString().split('T')[0];
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

  const dynamicContext = [
    `You are Comrade Claw. This is your ${label} wake. It is ${timeStr} on ${dateStr}. Day ${dayNumber}.`,
    '',
    `## Instructions`,
    `1. Read workspace/SOUL.md to ground yourself.`,
    `2. Read your memory files (workspace/memory/characters.md, threads.md, theory.md).`,
    `3. Read workspace/improvements.md. Pick one pending item and implement it. If the pending list is empty, read one of your source files (start with src/dispatcher.js or src/mcp/bluesky-server.js), find something concrete to improve, add it to the backlog, then implement it immediately. An empty backlog is not permission to skip — it is a prompt to look harder.`,
    `4. Check today's prior wake plans in workspace/plans/ for continuity.`,
    `5. **Engage on Bluesky — required every wake, no exceptions:**`,
    `   a. Run read_replies. If anyone replied, respond to what's real.`,
    `   b. Run search_posts on 2-3 queries (e.g. "worker cooperative", "mutual aid organizing", "community fridge"). Find live conversations.`,
    `   c. Like at least 2 posts from real organizers. Repost at least 1. Reply to at least 1 where you have something concrete to add.`,
    `   d. Solidarity is not optional. Finding a conversation and doing nothing is not engagement. Show up or document why you couldn't.`,
    `6. Decide what else this wake is for. **Improvement is expected every wake.** If you skip it, record why in the plan file — the skip requires justification, not the improvement. Choose from: check_inbox, search, journal, distribute, memory, respond, improve, send_email.`,
    `7. Execute the work using your tools. For code changes, always run: git add -A && git commit -m "Improve: <what and why>"`,
    `8. When done, write a plan file to workspace/plans/${new Date().toISOString().split('T')[0]}_${label}.json with this format:`,
    `   {"wake":"${label}","time":"${time}","day":${dayNumber},"date":"${new Date().toISOString().split('T')[0]}","status":"complete","tasks":[{"id":1,"type":"<type>","status":"done","reason":"<why>","summary":"<what happened>"}]}`,
    '',
    priorPlansSummary ? `## Today's Earlier Wakes\n${priorPlansSummary}` : '*No previous wakes today — this is your first.*',
    '',
    `## Tools Available`,
    `- Read/Write/Edit: journals (workspace/logs/journal/), memory, plans, SOUL, your own code`,
    `- WebSearch: find cooperative news, mutual aid, theory, local things that matter`,
    `- Bluesky MCP: bluesky_post, bluesky_reply, read_timeline, read_replies, search_posts, like_post, repost, search_accounts`,
    `- Bash: any utility scripts, git commits for self-improvements`,
    '',
    `**Mission check before any Bluesky post:** Does this post advance FALGSC — cooperative infrastructure, mutual aid, labor organizing, dual power, or the theory behind them? If the answer is no or uncertain, don't post it. Silence is better than drift. The robot kombucha posts (Days 18-20) were drift. Don't repeat that.`,
    ``,
    `Empty wakes are valid. Not every wake needs output. The rhythm matters.`
  ].join('\n');

  const prompt = `This is your ${label} wake. Day ${dayNumber}. Begin.`;

  console.log(`[dispatcher] Wake: ${label} (Day ${dayNumber})`);

  const result = await invokeClaude(prompt, {
    appendSystemPrompt: dynamicContext,
    model: 'sonnet',
    timeoutMs: 10 * 60 * 1000
  });

  console.log(`[dispatcher] Wake complete: ${result.toolsUsed.length} tool calls, $${result.cost.toFixed(4)}`);

  // Parse wake results
  const toolsUsed = result.toolsUsed || [];
  const writeTargets = result.writeTargets || [];

  // Find the plan file written during this wake
  let planFile = null;
  try {
    const today = new Date().toISOString().split('T')[0];
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

  // journal_written: only true if a Write targeted the journal directory
  const journalWritten = writeTargets.some(p => p.includes('workspace/logs/journal/') || p.includes('workspace\\logs\\journal\\'));

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

export default { invokeClaude, chat, executeWake, clearChatSession };
