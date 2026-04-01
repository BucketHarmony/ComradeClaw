/**
 * Operator Command Handler
 *
 * Commands are handled locally (fast, no LLM).
 * Everything else routes through the dispatcher to Claude Code.
 */

import { chat, clearChatSession } from './dispatcher.js';
import { getDayNumber } from './tools.js';
import { triggerWake, getWakeSummary, scheduleSelfWake, listSelfWakes, cancelSelfWake } from './scheduler.js';
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

  // list pending self-wakes
  if (textLower === 'scheduled') {
    const pending = await listSelfWakes();
    if (pending.length === 0) return 'No self-wakes pending.';
    const lines = pending.map(w => {
      const fireAt = new Date(w.fire_at).toLocaleString('en-US', { timeZone: 'America/Detroit', hour12: true });
      return `• \`${w.id.slice(-5)}\` **${w.label}** @ ${fireAt}\n  ${w.purpose}`;
    });
    return `**Pending self-wakes (${pending.length}):**\n${lines.join('\n')}`;
  }

  // cancel a self-wake: cancel <id-suffix>
  if (textLower.startsWith('cancel ')) {
    const idSuffix = text.slice(7).trim();
    const pending = await listSelfWakes();
    const match = pending.find(w => w.id.endsWith(idSuffix) || w.id === idSuffix);
    if (!match) return `No pending self-wake matching "${idSuffix}".`;
    await cancelSelfWake(match.id);
    return `Cancelled: **${match.label}** — ${match.purpose}`;
  }

  // schedule a self-wake: schedule <minutes> <label> <purpose...>
  if (textLower.startsWith('schedule ')) {
    const parts = text.slice(9).trim().split(' ');
    const mins = parseInt(parts[0], 10);
    const label = parts[1];
    const purpose = parts.slice(2).join(' ');
    if (!mins || isNaN(mins) || !label || !purpose) {
      return 'Usage: `schedule <minutes> <label> <purpose>`\nExample: `schedule 30 upgrade Implement Layer 0 cost cap`';
    }
    const entry = await scheduleSelfWake(label, mins, purpose);
    const fireAt = new Date(entry.fire_at).toLocaleString('en-US', { timeZone: 'America/Detroit', hour12: true });
    return `⏰ Self-wake scheduled: **${label}** in ${mins}m (${fireAt})\n${purpose}`;
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
• \`scheduled\` — List pending self-wakes
• \`schedule <mins> <label> <purpose>\` — Schedule a self-wake
• \`cancel <id>\` — Cancel a pending self-wake
• \`help\` — Show this message

Any other message is a direct chat with Comrade Claw (via Claude Code).

**Scheduled Wakes:** 9am, noon, 3pm, 6pm, 11pm
**Self-wakes:** Claw can schedule these autonomously for deep research or intensive upgrades.`;
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
