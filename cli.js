#!/usr/bin/env node
/**
 * Comrade Claw CLI
 *
 * Direct chat with the SOUL via command line.
 * All conversations logged to workspace/logs/chat/YYYY-MM-DD.md
 */

import 'dotenv/config';
import readline from 'readline';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Anthropic from '@anthropic-ai/sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, 'workspace');
const SOUL_PATH = path.join(WORKSPACE_PATH, 'AGENTS.md');
const CHAT_LOG_DIR = path.join(WORKSPACE_PATH, 'logs', 'chat');

// Conversation state
let conversationHistory = [];
let soul = '';

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
 * Append to today's chat log
 */
async function logToMarkdown(role, content) {
  await ensureLogDir();
  const logFile = path.join(CHAT_LOG_DIR, `${getDateString()}.md`);

  const timestamp = getTimestamp();
  const roleLabel = role === 'user' ? '**You**' : '**Claw**';
  const entry = `\n### ${roleLabel} (${timestamp})\n\n${content}\n\n---\n`;

  // Check if file exists, if not add header
  try {
    await fs.access(logFile);
  } catch {
    const header = `# Chat Log — ${getDateString()}\n\n---\n`;
    await fs.writeFile(logFile, header);
  }

  await fs.appendFile(logFile, entry);
}

/**
 * Log full API request to markdown
 */
async function logFullRequest(userMessage, assistantResponse) {
  await ensureLogDir();
  const logFile = path.join(CHAT_LOG_DIR, `${getDateString()}.md`);
  const timestamp = getTimestamp();

  const fullLog = `
## Full API Request (${timestamp})

### System Prompt (SOUL)

\`\`\`
${soul}
\`\`\`

### Conversation History

\`\`\`json
${JSON.stringify(conversationHistory.slice(0, -1), null, 2)}
\`\`\`

### User Message

${userMessage}

### Assistant Response

${assistantResponse}

---

`;

  await fs.appendFile(logFile, fullLog);
}

/**
 * Read the SOUL
 */
async function readSoul() {
  try {
    soul = await fs.readFile(SOUL_PATH, 'utf-8');
    return true;
  } catch (error) {
    console.error(`Could not read SOUL at ${SOUL_PATH}: ${error.message}`);
    return false;
  }
}

/**
 * Send message to Claude
 */
async function chat(userMessage) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Add to history
  conversationHistory.push({
    role: 'user',
    content: userMessage
  });

  // Trim if too long
  if (conversationHistory.length > 40) {
    conversationHistory = conversationHistory.slice(-40);
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: soul,
    messages: conversationHistory
  });

  const assistantMessage = response.content[0].text;

  conversationHistory.push({
    role: 'assistant',
    content: assistantMessage
  });

  return assistantMessage;
}

/**
 * Main CLI loop
 */
async function main() {
  console.log('='.repeat(50));
  console.log('COMRADE CLAW CLI');
  console.log('='.repeat(50));
  console.log('');

  // Load SOUL
  if (!await readSoul()) {
    process.exit(1);
  }
  console.log(`SOUL loaded: ${soul.length} chars`);
  console.log(`Chat logs: ${CHAT_LOG_DIR}`);
  console.log('');
  console.log('Type your message. Commands: /clear, /quit');
  console.log('-'.repeat(50));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Commands
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\nGoodbye.');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/clear') {
        conversationHistory = [];
        console.log('\nConversation cleared.\n');
        prompt();
        return;
      }

      if (trimmed === '/help') {
        console.log('\nCommands:');
        console.log('  /clear — Clear conversation history');
        console.log('  /quit  — Exit CLI');
        console.log('  /help  — Show this message\n');
        prompt();
        return;
      }

      // Get response
      try {
        process.stdout.write('\nClaw: ');
        const response = await chat(trimmed);
        console.log(response);
        console.log('');

        // Log full request with SOUL, history, and response
        await logFullRequest(trimmed, response);
      } catch (error) {
        console.error(`\nError: ${error.message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
