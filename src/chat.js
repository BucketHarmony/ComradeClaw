/**
 * Direct Chat Module
 *
 * Handles direct conversation with Comrade Claw.
 * Messages are sent to Claude with the SOUL as system prompt.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');

// Conversation history (in-memory for now)
let conversationHistory = [];
const MAX_HISTORY = 20; // Keep last 20 exchanges

/**
 * Read AGENTS.md (the SOUL)
 */
async function readSoul() {
  const filePath = path.join(WORKSPACE_PATH, 'AGENTS.md');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error(`[chat] Could not read AGENTS.md: ${error.message}`);
    throw error;
  }
}

/**
 * Chat with Comrade Claw
 */
export async function chat(userMessage) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Read the SOUL
  const soul = await readSoul();

  // Add user message to history
  conversationHistory.push({
    role: 'user',
    content: userMessage
  });

  // Trim history if too long
  if (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
  }

  console.log(`[chat] Sending message to Claude...`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    system: soul,
    messages: conversationHistory
  });

  const assistantMessage = response.content[0].text;

  // Add assistant response to history
  conversationHistory.push({
    role: 'assistant',
    content: assistantMessage
  });

  console.log(`[chat] Response: ${assistantMessage.length} chars`);

  return assistantMessage;
}

/**
 * Clear conversation history
 */
export function clearHistory() {
  conversationHistory = [];
  return 'Conversation cleared.';
}

/**
 * Get conversation stats
 */
export function getStats() {
  return {
    messageCount: conversationHistory.length,
    historyLength: conversationHistory.length / 2
  };
}

export default { chat, clearHistory, getStats };
