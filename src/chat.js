/**
 * Direct Chat Module
 *
 * Handles direct conversation with Comrade Claw.
 * Uses shared persistent history from history.js.
 * Messages are sent to Claude with the SOUL as system prompt.
 * Tools are available for journal writing, memory updates, and posting.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadHistory, saveExchange, getContextMessages, clearHistory as clearHistoryFile } from './history.js';
import { toolDefinitions, executeTool, getDayNumber, loadMemoryForPrompt, loadRecentJournals } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const CHAT_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'chat');

let currentSystemPrompt = '';

/**
 * Get today's date string
 */
function getDateString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get timestamp
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Ensure log directory exists
 */
async function ensureLogDir() {
  await fs.mkdir(CHAT_LOG_DIR, { recursive: true });
}

/**
 * Log full API request to markdown
 */
async function logFullRequest(userMessage, assistantResponse, contextMessages, toolCalls = []) {
  await ensureLogDir();
  const logFile = path.join(CHAT_LOG_DIR, `${getDateString()}.md`);
  const timestamp = getTimestamp();

  // Check if file exists, if not add header
  try {
    await fs.access(logFile);
  } catch {
    const header = `# Chat Log — ${getDateString()}\n\n---\n`;
    await fs.writeFile(logFile, header);
  }

  let toolLog = '';
  if (toolCalls.length > 0) {
    toolLog = `\n### Tool Calls\n\n\`\`\`json\n${JSON.stringify(toolCalls, null, 2)}\n\`\`\`\n`;
  }

  const fullLog = `
## Full API Request (${timestamp})

### System Prompt

\`\`\`
${currentSystemPrompt}
\`\`\`

### Conversation History (${contextMessages.length} messages in context)

\`\`\`json
${JSON.stringify(contextMessages, null, 2)}
\`\`\`

### User Message

${userMessage}
${toolLog}
### Assistant Response

${assistantResponse}

---

`;

  await fs.appendFile(logFile, fullLog);
}

/**
 * Read SOUL.md (the core identity)
 */
async function readSoul() {
  const filePath = path.join(WORKSPACE_PATH, 'SOUL.md');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    // Fall back to AGENTS.md if SOUL.md doesn't exist
    const fallbackPath = path.join(WORKSPACE_PATH, 'AGENTS.md');
    try {
      return await fs.readFile(fallbackPath, 'utf-8');
    } catch {
      console.error(`[chat] Could not read SOUL: ${error.message}`);
      throw error;
    }
  }
}

/**
 * Build full system prompt with SOUL, day counter, and memory
 */
async function buildSystemPrompt() {
  const soul = await readSoul();
  const dayNumber = await getDayNumber();
  const memory = await loadMemoryForPrompt();
  const recentJournals = await loadRecentJournals(2);

  const tz = process.env.TIMEZONE || process.env.TZ || 'America/Detroit';

  const dateStr = new Date().toLocaleDateString('en-US', {
    timeZone: tz,
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

  let prompt = soul;

  // Add day counter, date, time, and wake schedule
  prompt += `\n\n---\n\n## Current State\n\n`;
  prompt += `**Today:** ${dateStr}\n`;
  prompt += `**Current Time:** ${timeStr} (${tz})\n`;
  prompt += `**Day Number:** ${dayNumber}\n`;
  prompt += `**Journal Entries:** ${recentJournals.length > 0 ? recentJournals.length + ' previous' : 'None yet — this is the beginning'}\n`;
  prompt += `\n**Daily Wake Schedule:** Morning 9:00 AM · Noon 12:00 PM · Afternoon 3:00 PM · Evening 6:00 PM · Night 11:00 PM\n`;

  // Add memory sections
  prompt += `\n---\n\n## Memory\n\n`;
  prompt += `### Characters\n\n${memory.characters}\n\n`;
  prompt += `### Open Threads\n\n${memory.threads}\n\n`;
  prompt += `### Theory Notes\n\n${memory.theory}\n\n`;

  // Add recent journal context if exists
  if (recentJournals.length > 0) {
    prompt += `---\n\n## Recent Journal Entries\n\n`;
    for (const entry of recentJournals.reverse()) {
      prompt += `${entry}\n\n---\n\n`;
    }
  }

  // Add tools documentation
  prompt += `---\n\n## Available Tools\n\n`;
  prompt += `You have access to the following tools:\n\n`;
  for (const tool of toolDefinitions) {
    prompt += `- **${tool.name}**: ${tool.description}\n`;
  }
  prompt += `\nUse these tools when appropriate. You can write journal entries, update your memory, search the web, and post to Bluesky.\n`;

  return prompt;
}

/**
 * Chat with Comrade Claw (Discord channel)
 */
export async function chat(userMessage) {
  return chatWithChannel(userMessage, 'discord');
}

/**
 * Chat with channel tag - handles tool use loop
 */
export async function chatWithChannel(userMessage, channel = 'unknown') {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build full system prompt
  currentSystemPrompt = await buildSystemPrompt();

  // Load history and get context messages
  const history = await loadHistory();
  const contextMessages = getContextMessages(history);

  // Add current user message to context for this request
  let messages = [
    ...contextMessages,
    { role: 'user', content: userMessage }
  ];

  console.log(`[chat] Sending message to Claude (${contextMessages.length} history messages, tools enabled)...`);

  const toolCalls = [];
  let finalResponse = '';

  // Tool use loop
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: currentSystemPrompt,
      tools: toolDefinitions,
      messages: messages
    });

    // Check if we need to handle tool use
    if (response.stop_reason === 'tool_use') {
      // Find tool use blocks
      const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');

      // Execute each tool
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[chat] Tool call: ${toolUse.name}`);
        const result = await executeTool(toolUse.name, toolUse.input);
        toolCalls.push({
          name: toolUse.name,
          input: toolUse.input,
          result: result
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      }

      // Add assistant response and tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });

      // Continue the loop to get next response
      continue;
    }

    // Extract text response
    const textBlocks = response.content.filter(block => block.type === 'text');
    finalResponse = textBlocks.map(block => block.text).join('\n');
    break;
  }

  // Save exchange to persistent history
  await saveExchange(userMessage, finalResponse, channel);

  // Log full request with SOUL, history, tools, and response
  await logFullRequest(userMessage, finalResponse, contextMessages, toolCalls);

  console.log(`[chat] Response: ${finalResponse.length} chars, ${toolCalls.length} tool calls`);

  return finalResponse;
}

/**
 * Clear conversation history
 */
export async function clearHistory() {
  await clearHistoryFile();
  return 'Conversation cleared.';
}

/**
 * Get current day number (exported for CLI)
 */
export { getDayNumber };

export default { chat, chatWithChannel, clearHistory, getDayNumber };
