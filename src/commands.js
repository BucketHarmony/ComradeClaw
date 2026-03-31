/**
 * Operator Command Handler
 *
 * Commands are handled locally (fast, no LLM).
 * Everything else routes through the dispatcher to Claude Code.
 */

import { chat, clearChatSession } from './dispatcher.js';
import { getDayNumber } from './tools.js';
import { triggerWake, getWakeSummary } from './scheduler.js';
import { getLatestPlanPath, readPlan } from './tools.js';
import { formatPlan } from './plan-format.js';

/**
 * Handle operator message (command or chat)
 */
export async function handleOperatorCommand(message, context) {
  const text = message.trim();
  const textLower = text.toLowerCase();

  // status
  if (textLower === 'status') {
    const dayNumber = await getDayNumber();
    const wakeSummary = await getWakeSummary();
    return `▶️ Online — Day ${dayNumber}\n\n${wakeSummary}`;
  }

  // clear conversation
  if (textLower === 'clear') {
    await clearChatSession();
    return 'Conversation cleared.';
  }

  // trigger wake manually
  if (textLower === 'wake' || textLower.startsWith('wake ')) {
    const parts = textLower.split(' ');
    const label = parts[1] || null;

    try {
      const validLabels = ['morning', 'noon', 'afternoon', 'evening', 'night'];
      if (label && !validLabels.includes(label)) {
        return `Unknown wake: ${label}. Valid: ${validLabels.join(', ')}`;
      }

      triggerWake(label).then(result => {
        console.log(`[commands] Manual wake complete: ${result.summary}`);
      }).catch(err => {
        console.error(`[commands] Manual wake error: ${err.message}`);
      });

      return `⏰ Triggering ${label || 'current'} wake...`;
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }

  // show wake summary
  if (textLower === 'wakes') {
    return await getWakeSummary();
  }

  // show latest wake plan
  if (textLower === 'plan') {
    try {
      const planPath = await getLatestPlanPath();
      if (!planPath) return 'No wake plans yet.';
      const plan = await readPlan(planPath);
      return formatPlan(plan);
    } catch (error) {
      return `Error reading plan: ${error.message}`;
    }
  }

  // help
  if (textLower === 'help') {
    return `Commands:
• \`status\` — Check status and today's wakes
• \`clear\` — Clear conversation session
• \`wake\` — Trigger a wake now (or \`wake morning\`, \`wake noon\`, etc.)
• \`wakes\` — Show today's wake summary
• \`plan\` — Show the latest wake plan
• \`help\` — Show this message

Any other message is a direct chat with Comrade Claw (via Claude Code).

**Scheduled Wakes:** 9am, noon, 3pm, 6pm, 11pm`;
  }

  // Everything else goes through Claude Code
  try {
    const response = await chat(text);
    return response;
  } catch (error) {
    console.error(`[commands] Chat error: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

export default { handleOperatorCommand };
