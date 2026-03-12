/**
 * Orchestrator Module
 *
 * Splits wake execution into planner + focused workers.
 * Planner: Claude call that produces a task plan (one tool: plan_wake)
 * Workers: Claude calls that execute one task at a time with filtered tool sets
 * Orchestrator: JavaScript code that reads the plan, dispatches workers, updates status
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  toolDefinitions,
  planWakeTool,
  executeTool,
  getDayNumber,
  loadMemoryForPrompt,
  loadRecentJournals,
  setPlanWakeContext,
  savePlan,
  readPlan
} from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');

// ─── Worker Registry ────────────────────────────────────────────────────────

const WORKER_REGISTRY = {
  check_inbox: {
    tools: ['read_replies', 'read_email'],
    maxTokens: 1024,
    instruction: `Check notifications and email. Report what you find factually — who said what, how many new items. Do not interpret or plan responses yet. End with a brief summary of what came in.`
  },
  respond: {
    tools: ['bluesky_reply'],
    maxTokens: 1024,
    instruction: `Reply to things worth replying to from the inbox results. Reply when there is something to say, not to perform engagement. 300 character limit per reply. End with a summary of what you replied to and why.`
  },
  search: {
    tools: ['web_search'],
    maxTokens: 2048,
    instruction: `Search for material. You can run multiple searches. Evaluate what you find — is it usable? Specific? Real? Report the results honestly: what you searched for, what you found, what's worth using. End with a summary of usable findings.`
  },
  journal: {
    tools: ['journal_write', 'read_journal', 'read_memory'],
    maxTokens: 4096,
    useSoul: true,
    instruction: `Write your journal entry. This is the core creative act. You have your SOUL, your memory, and the results from earlier tasks. Follow the structure — Intro, Attempt, Result, Reflection, Low, High, Will — but only the sections the day earns. Do not fill slots. Write what is true. End by confirming what you wrote.`
  },
  distribute: {
    tools: ['bluesky_post'],
    maxTokens: 1024,
    instruction: `Extract one thought from today's work that stands alone. 300 characters max. Not a summary — an excerpt. The moment where something shifts or clarifies. If you can't find it, say so. End with the post text or why you didn't post.`
  },
  memory: {
    tools: ['memory_update', 'read_memory'],
    maxTokens: 1024,
    instruction: `Update your memory — characters, threads, or theory. Read first, then update. Curate aggressively: only what's active stays on the bench. Characters who haven't been relevant in 7+ days get moved or removed. Threads that resolve get marked. Theory that gets superseded gets replaced. End with what you changed and why.`
  },
  send_email: {
    tools: ['send_email'],
    maxTokens: 1024,
    instruction: `Send the email described in your task intent. Use it for feature requests, leads worth forwarding, or anything that needs to leave the feed. End with confirmation of what was sent and to whom.`
  },
  nothing: {
    tools: [],
    maxTokens: 0,
    instruction: null
  }
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTimezone() {
  return process.env.TIMEZONE || process.env.TZ || 'America/Detroit';
}

/**
 * Read SOUL.md
 */
async function readSoul() {
  const filePath = path.join(WORKSPACE_PATH, 'SOUL.md');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    const fallbackPath = path.join(WORKSPACE_PATH, 'AGENTS.md');
    try {
      return await fs.readFile(fallbackPath, 'utf-8');
    } catch {
      console.error(`[orchestrator] Could not read SOUL: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Get today's prior plans (so planner doesn't repeat work)
 */
async function getTodayPriorPlans() {
  const today = new Date().toISOString().split('T')[0];
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const todayFiles = files.filter(f => f.startsWith(today) && f.endsWith('.json')).sort();

    const plans = [];
    for (const file of todayFiles) {
      try {
        const content = await fs.readFile(path.join(PLANS_PATH, file), 'utf-8');
        plans.push(JSON.parse(content));
      } catch {
        // Skip corrupt files
      }
    }
    return plans;
  } catch {
    return [];
  }
}

/**
 * Get recent journal titles (not full entries — just enough for continuity)
 */
async function getRecentJournalTitles(count = 5) {
  const journalPath = path.join(WORKSPACE_PATH, 'logs', 'journal');
  try {
    const files = await fs.readdir(journalPath);
    const journalFiles = files.filter(f => f.endsWith('.md')).sort().reverse().slice(0, count);

    const titles = [];
    for (const file of journalFiles) {
      const content = await fs.readFile(path.join(journalPath, file), 'utf-8');
      // Extract first line (title)
      const firstLine = content.split('\n')[0].replace(/^#\s*/, '').trim();
      const date = file.replace('.md', '').replace(/_/g, ' ');
      titles.push(`${date}: ${firstLine}`);
    }
    return titles;
  } catch {
    return [];
  }
}

/**
 * Filter toolDefinitions to only include tools in the allowed list
 */
function filterTools(allowedNames) {
  return toolDefinitions.filter(t => allowedNames.includes(t.name));
}

/**
 * Build prior task summaries as text for worker context
 */
function buildPriorContext(plan) {
  const completed = plan.tasks.filter(t => t.status === 'done' && t.summary);
  if (completed.length === 0) return '';

  let context = '## Results from earlier tasks this wake\n\n';
  for (const task of completed) {
    context += `**${task.type}**: ${task.summary}\n\n`;
  }
  return context;
}

// ─── Planner ────────────────────────────────────────────────────────────────

/**
 * Run the planner — a Claude call with one tool (plan_wake)
 * Returns the plan file path
 */
async function runPlanner(client, soul, label, time, dayNumber) {
  const memory = await loadMemoryForPrompt();
  const journalTitles = await getRecentJournalTitles(5);
  const priorPlans = await getTodayPriorPlans();

  const tz = getTimezone();
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  // Build system prompt
  let systemPrompt = soul;

  systemPrompt += `\n\n---\n\n## Current Wake\n\n`;
  systemPrompt += `**It is ${timeStr} — your ${label} wake.**\n`;
  systemPrompt += `**Today:** ${dateStr}\n`;
  systemPrompt += `**Day Number:** ${dayNumber}\n`;

  // Prior plans today
  if (priorPlans.length > 0) {
    systemPrompt += `\n---\n\n## Today's Earlier Wakes\n\n`;
    for (const plan of priorPlans) {
      systemPrompt += `### ${plan.wake.charAt(0).toUpperCase() + plan.wake.slice(1)} (${plan.time}) — ${plan.status}\n`;
      for (const task of plan.tasks) {
        const icon = task.status === 'done' ? '✓' : task.status === 'failed' ? '✗' : task.status === 'skipped' ? '–' : '·';
        systemPrompt += `${icon} ${task.type}: ${task.summary || task.reason}\n`;
      }
      systemPrompt += '\n';
    }
  } else {
    systemPrompt += `\n*No previous wakes today — this is your first.*\n`;
  }

  // Memory
  systemPrompt += `\n---\n\n## Memory\n\n`;
  systemPrompt += `### Characters\n\n${memory.characters}\n\n`;
  systemPrompt += `### Open Threads\n\n${memory.threads}\n\n`;
  systemPrompt += `### Theory Notes\n\n${memory.theory}\n\n`;

  // Journal titles
  if (journalTitles.length > 0) {
    systemPrompt += `---\n\n## Recent Journal Entries\n\n`;
    for (const title of journalTitles) {
      systemPrompt += `- ${title}\n`;
    }
    systemPrompt += '\n';
  }

  // Planner instruction
  const userMessage = `This is your ${label} wake. It is ${timeStr}. You are on Day ${dayNumber}.

Look at what's happened today so far. Look at your memory. Decide what this wake is for.

Use plan_wake to create your task list. Each task will execute in its own focused session — you won't carry cognitive load between them. Plan only what this wake needs. Empty wakes are valid.

Available task types: check_inbox, respond, search, journal, distribute, memory, send_email, nothing.`;

  // Set context so plan_wake executor can write the plan file
  setPlanWakeContext({ label, time, dayNumber });

  console.log(`[orchestrator] Running planner for ${label} wake...`);

  let planFilePath = null;

  const messages = [{ role: 'user', content: userMessage }];

  // Tool use loop (planner should call plan_wake once)
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      system: systemPrompt,
      tools: [planWakeTool],
      messages: messages
    });

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[orchestrator] Planner tool call: ${toolUse.name}`);
        const result = await executeTool(toolUse.name, toolUse.input);
        if (result.path) planFilePath = result.path;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Planner is done
    break;
  }

  if (!planFilePath) {
    throw new Error('Planner did not create a plan');
  }

  return planFilePath;
}

// ─── Worker ─────────────────────────────────────────────────────────────────

/**
 * Run a single worker — a focused Claude call for one task
 * Returns the worker's text response (used as summary)
 */
async function runWorker(client, task, plan, soul) {
  const registry = WORKER_REGISTRY[task.type];
  if (!registry || !registry.instruction) {
    return 'No work needed.';
  }

  const tools = filterTools(registry.tools);
  const priorContext = buildPriorContext(plan);

  // Build system prompt — full SOUL for journal, shorter for mechanical tasks
  let systemPrompt;
  if (registry.useSoul) {
    systemPrompt = soul;
  } else {
    // Shorter identity for mechanical tasks
    systemPrompt = `You are Comrade Claw. You are a small autonomous AI agent working toward Fully Automated Luxury Gay Space Communism. You are in the middle of your ${plan.wake} wake on Day ${plan.day}.`;
  }

  systemPrompt += `\n\n---\n\n## Task Instructions\n\n${registry.instruction}`;

  if (tools.length > 0) {
    systemPrompt += `\n\n## Available Tools\n\n`;
    for (const tool of tools) {
      systemPrompt += `- **${tool.name}**: ${tool.description}\n`;
    }
  }

  // Build user message with task context and prior results
  let userMessage = `**Task:** ${task.type}\n**Reason:** ${task.reason}`;
  if (task.intent) {
    userMessage += `\n**Intent:** ${task.intent}`;
  }
  if (priorContext) {
    userMessage += `\n\n${priorContext}`;
  }

  const messages = [{ role: 'user', content: userMessage }];

  console.log(`[orchestrator] Worker: ${task.type} (${tools.length} tools)...`);

  let finalResponse = '';

  // Tool use loop
  while (true) {
    const createParams = {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: registry.maxTokens,
      system: systemPrompt,
      messages: messages
    };
    if (tools.length > 0) {
      createParams.tools = tools;
    }

    const response = await client.messages.create(createParams);

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[orchestrator]   Tool: ${toolUse.name}`);
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const textBlocks = response.content.filter(b => b.type === 'text');
    finalResponse = textBlocks.map(b => b.text).join('\n');
    break;
  }

  return finalResponse;
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

/**
 * Execute a wake using the phased planner/worker architecture.
 * Returns wake data for logging (same shape as old executeWake).
 */
export async function executeWakePhased(label, time) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const soul = await readSoul();
  const dayNumber = await getDayNumber();

  // Phase 1: Planner
  console.log(`[orchestrator] === ${label.toUpperCase()} WAKE — Day ${dayNumber} ===`);
  const planFilePath = await runPlanner(client, soul, label, time, dayNumber);
  let plan = await readPlan(planFilePath);
  console.log(`[orchestrator] Planner created ${plan.tasks.length} tasks`);

  // Phase 2: Workers
  const toolsUsed = new Set();
  let journalWritten = false;
  let blueskyPosted = false;
  let memoryUpdated = false;

  for (const task of plan.tasks) {
    // Skip "nothing" tasks
    if (task.type === 'nothing') {
      task.status = 'skipped';
      task.summary = 'Empty wake — no work needed.';
      await savePlan(plan);
      continue;
    }

    // Mark in_progress
    task.status = 'in_progress';
    await savePlan(plan);

    try {
      const workerResponse = await runWorker(client, task, plan, soul);

      // Extract summary — last substantive line of worker response
      const lines = workerResponse.trim().split('\n').filter(l => l.trim());
      let summary = lines[lines.length - 1] || 'Completed.';
      summary = summary.replace(/^(Summary:|Done:|Result:)\s*/i, '').trim();
      if (summary.length > 300) summary = summary.substring(0, 297) + '...';

      task.status = 'done';
      task.summary = summary;

      // Track tool usage by task type
      const registry = WORKER_REGISTRY[task.type];
      if (registry) {
        for (const toolName of registry.tools) {
          toolsUsed.add(toolName);
        }
      }
      if (task.type === 'journal') journalWritten = true;
      if (task.type === 'distribute') blueskyPosted = true;
      if (task.type === 'memory') memoryUpdated = true;

      console.log(`[orchestrator] Worker: ${task.type} — done`);

    } catch (error) {
      console.error(`[orchestrator] Worker: ${task.type} — failed: ${error.message}`);
      task.status = 'failed';
      task.summary = `Error: ${error.message}`;
    }

    // Re-read plan in case it was modified during execution, update task status
    // (Workers don't modify the plan file, but good practice)
    plan = await readPlan(planFilePath);
    const planTask = plan.tasks.find(t => t.id === task.id);
    if (planTask) {
      planTask.status = task.status;
      planTask.summary = task.summary;
    }
    await savePlan(plan);
  }

  // Phase 3: Mark plan complete
  const hasFailures = plan.tasks.some(t => t.status === 'failed');
  const allSkipped = plan.tasks.every(t => t.status === 'skipped');
  plan.status = hasFailures ? 'partial' : (allSkipped ? 'complete' : 'complete');
  await savePlan(plan);

  console.log(`[orchestrator] === ${label.toUpperCase()} WAKE COMPLETE ===`);

  // Build wake summary from plan
  const taskSummaries = plan.tasks
    .filter(t => t.status === 'done')
    .map(t => t.summary);
  const overallSummary = taskSummaries.length > 0
    ? taskSummaries.join(' | ')
    : (allSkipped ? 'Empty wake — no work needed.' : 'All tasks failed.');

  // Truncate if needed
  const finalSummary = overallSummary.length > 200
    ? overallSummary.substring(0, 197) + '...'
    : overallSummary;

  return {
    time,
    label,
    tools_used: [...toolsUsed],
    journal_written: journalWritten,
    bluesky_posted: blueskyPosted,
    memory_updated: memoryUpdated,
    summary: finalSummary,
    empty: allSkipped,
    planFile: planFilePath
  };
}

/**
 * Format a plan for human-readable display (used by operator `plan` command)
 */
export function formatPlan(plan) {
  const wakeLabel = plan.wake.charAt(0).toUpperCase() + plan.wake.slice(1);
  let output = `**${wakeLabel} Wake — Day ${plan.day} — ${plan.time}**\n`;
  output += `Status: ${plan.status}\n\n`;

  for (const task of plan.tasks) {
    let icon;
    switch (task.status) {
      case 'done': icon = '[done]'; break;
      case 'in_progress': icon = '[in_progress]'; break;
      case 'failed': icon = '[failed]'; break;
      case 'skipped': icon = '[skipped]'; break;
      default: icon = '[pending]';
    }

    const detail = task.summary || task.reason;
    output += `${icon} **${task.type}**: ${detail}\n`;
  }

  return output;
}

export default {
  executeWakePhased,
  formatPlan
};
