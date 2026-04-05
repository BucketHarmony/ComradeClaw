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
  const effectiveness = plan.effectiveness ? ` | E: ${plan.effectiveness.score}/${plan.effectiveness.max}` : '';
  const line1 = `**${wakeLabel} Wake** — Day ${plan.day} — ${plan.time}${quality}${effectiveness}`;

  const topTask = (plan.tasks || []).find(t => t.status === 'done') || plan.tasks?.[0];
  const taskSummary = topTask ? (topTask.summary || topTask.reason || topTask.type) : 'no tasks';
  const truncated = taskSummary.length > 120 ? taskSummary.substring(0, 117) + '...' : taskSummary;

  const bold = plan.bold_check
    ? (plan.bold_check.toLowerCase().startsWith('yes') ? '✓ bold' : '~ safe')
    : '';
  const line2 = `↳ ${truncated}${bold ? '  [' + bold + ']' : ''}`;

  return `${line1}\n${line2}`;
}

/**
 * Compute wake effectiveness score (0-10).
 * Dimensions: engagement checked (1), improvement done (2), theory distributed (2),
 * organizer engaged (2), new follow made (1), journal written (2).
 */
export function computeEffectivenessScore(plan) {
  const tasks = plan.tasks || [];
  const taskDone = (type) => tasks.some(t => t.status === 'done' && t.type === type);
  const anyTaskDone = (...types) => tasks.some(t => t.status === 'done' && types.includes(t.type));
  const summaryContains = (...words) => tasks.some(t =>
    t.status === 'done' && words.some(w => (t.summary || '').toLowerCase().includes(w.toLowerCase()))
  );

  const breakdown = {};

  // 1pt — engagement checked (checked replies or notifications)
  breakdown.engagement_checked = anyTaskDone('respond', 'engage', 'check') ? 1 : 0;

  // 2pt — improvement implemented
  breakdown.improvement_done = taskDone('improve') ? 2 : 0;

  // 2pt — theory distributed
  breakdown.theory_distributed = (plan.theory_praxis && plan.theory_praxis !== 'none') ? 2 : 0;

  // 2pt — organizer engaged (respond task done, summary not just "0 new")
  breakdown.organizer_engaged = tasks.some(t =>
    t.status === 'done' &&
    ['respond', 'engage', 'reply'].includes(t.type) &&
    !/0 new|no new|no replies|nothing new/i.test(t.summary || '')
  ) ? 2 : 0;

  // 1pt — new follow made
  breakdown.new_follow = summaryContains('follow', 'followed') ? 1 : 0;

  // 2pt — journal written
  breakdown.journal_written = taskDone('journal') ? 2 : 0;

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { score, max: 10, breakdown };
}

export default { formatPlan, formatPlanCompact, computeEffectivenessScore };
