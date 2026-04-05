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
      : '';
    output += `${icon} **${task.type}**: ${detail}${toolInfo}\n`;
  }

  return output;
}

/**
 * Compact 2-line plan summary for Discord wake notifications.
 * Line 1: label, day, time, quality score
 * Line 2: top task summary + bold_check verdict
 */
export function formatPlanCompact(plan) {
  const wakeLabel = plan.wake.charAt(0).toUpperCase() + plan.wake.slice(1);
  const quality = plan.quality_score ? ` | Q: ${plan.quality_score}` : '';
  const line1 = `**${wakeLabel} Wake** — Day ${plan.day} — ${plan.time}${quality}`;

  const topTask = (plan.tasks || []).find(t => t.status === 'done') || plan.tasks?.[0];
  const taskSummary = topTask ? (topTask.summary || topTask.reason || topTask.type) : 'no tasks';
  const truncated = taskSummary.length > 120 ? taskSummary.substring(0, 117) + '...' : taskSummary;

  const bold = plan.bold_check
    ? (plan.bold_check.toLowerCase().startsWith('yes') ? '✓ bold' : '~ safe')
    : '';
  const line2 = `↳ ${truncated}${bold ? '  [' + bold + ']' : ''}`;

  return `${line1}\n${line2}`;
}

export default { formatPlan, formatPlanCompact };
