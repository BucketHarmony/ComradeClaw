/**
 * Operator Command Handler
 *
 * Commands:
 * - status: Return current state
 * - clear: Clear conversation history
 * - help: Show available commands
 *
 * Any other message is treated as direct chat with Comrade Claw.
 */

import { chat, clearHistory } from './chat.js';

/**
 * Handle operator message (command or chat)
 */
export async function handleOperatorCommand(message, context) {
  const text = message.trim();
  const textLower = text.toLowerCase();

  // status
  if (textLower === 'status') {
    return '▶️ Online and ready to chat.';
  }

  // clear conversation
  if (textLower === 'clear') {
    return clearHistory();
  }

  // help
  if (textLower === 'help') {
    return `Commands:
• \`status\` — Check if online
• \`clear\` — Clear conversation history
• \`help\` — Show this message

Any other message is a direct chat with Comrade Claw.`;
  }

  // Everything else is chat
  try {
    const response = await chat(text);
    return response;
  } catch (error) {
    console.error(`[commands] Chat error: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

export default { handleOperatorCommand };
