/**
 * Plan formatting utility — extracted from orchestrator.js
 */

/**
 * Format a plan for human-readable display
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
    const toolInfo = task.toolCalls && task.toolCalls.length > 0
      ? ` (called: ${task.toolCalls.join(', ')})`
      : task.status === 'done' ? ' (no tools called)' : '';
    output += `${icon} **${task.type}**: ${detail}${toolInfo}\n`;
  }

  return output;
}

export default { formatPlan };
