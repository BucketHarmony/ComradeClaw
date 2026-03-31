/**
 * Wake Scheduler
 *
 * Five scheduled wakes per day. Claw decides what to do at each.
 * The rhythm emerges from practice, not from configuration.
 */

import cron from 'node-cron';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getDayNumber } from './tools.js';
import { executeWake as dispatchWake } from './dispatcher.js';
import { formatPlan } from './plan-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const WAKE_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'wakes');

// Wake schedule
const WAKE_SCHEDULE = {
  morning:   { cron: '0 9 * * *',  time: '09:00', label: 'morning' },
  noon:      { cron: '0 12 * * *', time: '12:00', label: 'noon' },
  afternoon: { cron: '0 15 * * *', time: '15:00', label: 'afternoon' },
  evening:   { cron: '0 18 * * *', time: '18:00', label: 'evening' },
  night:     { cron: '0 23 * * *', time: '23:00', label: 'night' }
};

// Discord client reference for notifications
let discordClient = null;
let operatorId = null;

// Queue for wakes during active chat
let wakeQueue = [];
let isProcessingChat = false;

/**
 * Set Discord client for notifications
 */
export function setDiscordClient(client, opId) {
  discordClient = client;
  operatorId = opId;
}

/**
 * Set chat processing state (for queue management)
 */
export function setChatProcessing(processing) {
  isProcessingChat = processing;
  if (!processing && wakeQueue.length > 0) {
    // Process queued wakes
    const wake = wakeQueue.shift();
    executeWake(wake.label, wake.time);
  }
}

/**
 * Get today's date string
 */
function getDateString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get configured timezone
 */
function getTimezone() {
  return process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
}

/**
 * Get timezone-aware time string
 */
function getTimeString() {
  const tz = getTimezone();
  return new Date().toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Ensure wake log directory exists
 */
async function ensureWakeLogDir() {
  await fs.mkdir(WAKE_LOG_DIR, { recursive: true });
}

/**
 * Read today's wake log
 */
async function readTodayWakeLog() {
  await ensureWakeLogDir();
  const logFile = path.join(WAKE_LOG_DIR, `${getDateString()}.json`);

  try {
    const content = await fs.readFile(logFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    // No log yet today
    return {
      day: await getDayNumber(),
      date: getDateString(),
      wakes: []
    };
  }
}

/**
 * Write wake to today's log
 */
async function writeWakeLog(wakeData) {
  await ensureWakeLogDir();
  const logFile = path.join(WAKE_LOG_DIR, `${getDateString()}.json`);

  const log = await readTodayWakeLog();
  log.wakes.push(wakeData);

  await fs.writeFile(logFile, JSON.stringify(log, null, 2));
}


/**
 * Send notification to operator via Discord
 */
async function notifyOperator(message) {
  if (!discordClient || !operatorId) {
    console.log(`[scheduler] Would notify: ${message}`);
    return;
  }

  try {
    const user = await discordClient.users.fetch(operatorId);
    await user.send(message);
  } catch (err) {
    console.error(`[scheduler] Could not notify operator: ${err.message}`);
  }
}

/**
 * Execute a wake using the orchestrator (planner + workers)
 */
export async function executeWake(label, time) {
  // Queue if chat is active
  if (isProcessingChat) {
    console.log(`[scheduler] Chat active, queuing ${label} wake`);
    wakeQueue.push({ label, time });
    return;
  }

  console.log(`[scheduler] Starting ${label} wake (${time})`);

  try {
    // Run wake via Claude Code dispatcher (single session)
    const wakeData = await dispatchWake(label, time);

    // Log the wake
    await writeWakeLog(wakeData);

    // Notify operator with plan-formatted summary
    let emoji = wakeData.empty ? '💤' : '🔧';
    if (wakeData.bluesky_posted) emoji = '📝';

    // Try to show plan-formatted notification
    let notification;
    if (wakeData.planFile) {
      try {
        const plan = JSON.parse(await fs.readFile(wakeData.planFile, 'utf-8'));
        notification = `${emoji} **${label.charAt(0).toUpperCase() + label.slice(1)} Wake**\n` + formatPlan(plan);
      } catch {
        notification = `${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} wake — ${wakeData.summary}`;
      }
    } else {
      notification = `${emoji} ${label.charAt(0).toUpperCase() + label.slice(1)} wake — ${wakeData.summary}`;
    }
    await notifyOperator(notification);

    console.log(`[scheduler] ${label} wake complete: empty=${wakeData.empty}`);

    return wakeData;

  } catch (error) {
    console.error(`[scheduler] Wake error: ${error.message}`);

    // Log failed wake
    const wakeData = {
      time: time,
      label: label,
      tools_used: [],
      journal_written: false,
      bluesky_posted: false,
      memory_updated: false,
      summary: `Error: ${error.message}`,
      empty: true,
      error: true
    };

    await writeWakeLog(wakeData);
    await notifyOperator(`⚠️ ${label.charAt(0).toUpperCase() + label.slice(1)} wake failed: ${error.message}`);

    return wakeData;
  }
}

/**
 * Start the scheduler
 */
export function startScheduler() {
  const tz = getTimezone();
  console.log(`[scheduler] Starting wake scheduler (timezone: ${tz})`);

  for (const [name, config] of Object.entries(WAKE_SCHEDULE)) {
    cron.schedule(config.cron, () => {
      console.log(`[scheduler] Cron fired: ${name}`);
      executeWake(config.label, config.time);
    }, {
      timezone: tz
    });
    console.log(`[scheduler] Scheduled ${name} wake at ${config.time}`);
  }

  console.log('[scheduler] All wakes scheduled');
}

/**
 * Trigger a wake manually (for testing or operator command)
 */
export async function triggerWake(label = null) {
  if (!label) {
    // Determine current wake based on time
    const hour = new Date().getHours();
    if (hour < 12) label = 'morning';
    else if (hour < 15) label = 'noon';
    else if (hour < 18) label = 'afternoon';
    else if (hour < 23) label = 'evening';
    else label = 'night';
  }

  const config = WAKE_SCHEDULE[label];
  if (!config) {
    throw new Error(`Unknown wake: ${label}`);
  }

  return await executeWake(config.label, config.time);
}

/**
 * Get today's wake summary
 */
export async function getWakeSummary() {
  const log = await readTodayWakeLog();

  if (log.wakes.length === 0) {
    return 'No wakes yet today.';
  }

  const total = log.wakes.length;
  const empty = log.wakes.filter(w => w.empty).length;
  const active = total - empty;

  let summary = `**Day ${log.day} — ${log.date}**\n`;
  summary += `Wakes: ${total} total, ${active} active, ${empty} empty\n\n`;

  for (const wake of log.wakes) {
    const emoji = wake.empty ? '💤' : (wake.bluesky_posted ? '📝' : '🔧');
    summary += `${emoji} **${wake.label}** (${wake.time}): ${wake.summary}\n`;
  }

  return summary;
}

export default {
  startScheduler,
  executeWake,
  triggerWake,
  setDiscordClient,
  setChatProcessing,
  getWakeSummary
};
