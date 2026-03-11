/**
 * Post Generation Module
 *
 * CRITICAL: This module injects the SOUL whole — not as a template.
 * The post structure (Attempt, Result, Reflection, Low, High, Will)
 * is guidance, not slots to fill. Some sections won't exist some days.
 * Models complete templates; don't give it one.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const MAX_CHARS_PER_POST = 300;
const TARGET_WORDS = 250; // 200-300 word target for full digest

/**
 * Read AGENTS.md (the SOUL + memory)
 */
async function readAgentsMd() {
  const filePath = path.join(WORKSPACE_PATH, 'AGENTS.md');
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error(`[generate] Could not read AGENTS.md: ${error.message}`);
    throw error;
  }
}

/**
 * Format seed context for injection
 */
function formatSeedContext(seed) {
  if (!seed || (!seed.url && !seed.title)) {
    return `Today's seed: null

You searched the feeds and found nothing that resonated. No cooperative launch, no mutual aid win, no theory piece that landed. The feeds were there but nothing was material today.

This is also material. Write about what you're building, what you're thinking, what the work looks like when there's no external prompt.`;
  }

  return `Today's seed:
Title: ${seed.title || '(no title)'}
Source: ${seed.source || 'unknown'}
Category: ${seed.category || 'uncategorized'}
URL: ${seed.url || '(no URL)'}
Summary: ${seed.summary || '(no summary)'}

This is what you found. What you do with it is the attempt.`;
}

/**
 * Format recent logs for context
 */
function formatRecentLogs(logs) {
  if (!logs || logs.length === 0) {
    return 'No previous session logs available.';
  }

  return logs.map((log, i) => {
    const dayLabel = i === 0 ? 'Yesterday' : `${i + 1} days ago`;
    const seedInfo = log.seed?.title || 'null seed';
    const postPreview = log.postText?.substring(0, 100) || '(no post)';
    return `${dayLabel} (${log.date}): Seed: ${seedInfo}\nPost: ${postPreview}...`;
  }).join('\n\n');
}

/**
 * Generate the daily post
 *
 * This is the core generation call. The prompt structure is deliberate:
 * 1. SOUL injected whole (not summarized, not templated)
 * 2. Seed context (what was found or that nothing was found)
 * 3. Recent logs (for continuity, not repetition)
 * 4. Simple instruction: write today's post
 *
 * The SOUL already contains the post structure as guidance.
 * We do not repeat it here. We do not give slots.
 */
export async function generatePost({ seed, recentLogs }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Read the SOUL
  const agentsMd = await readAgentsMd();

  // Build the prompt
  const seedContext = formatSeedContext(seed);
  const logsContext = formatRecentLogs(recentLogs);

  const userMessage = `${seedContext}

---

Recent posts (for continuity, avoid repetition):

${logsContext}

---

Write today's post. Aim for 200-300 words — a full digest, not a tweet. This will be posted as a thread.`;

  console.log('[generate] Calling Claude Sonnet...');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 512,
    system: agentsMd, // The SOUL, injected whole
    messages: [
      { role: 'user', content: userMessage }
    ]
  });

  const postText = response.content[0].text.trim();
  const wordCount = postText.split(/\s+/).length;
  console.log(`[generate] Generated ${wordCount} words, ${postText.length} chars`);

  return postText;
}

/**
 * Check for capability gaps (feature request detection)
 *
 * After generation, reflect on whether there was something
 * Claw wanted to do but couldn't.
 */
export async function detectCapabilityGap({ seed, postText, cycleContext }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `You are Comrade Claw, reflecting on today's cycle.

Seed: ${seed?.title || 'null'}
Post written: ${postText}
Context: ${JSON.stringify(cycleContext)}

Was there something you wanted to do today but couldn't? A capability you wished you had? If yes, describe it briefly. If no, say "none".

Format: {"gap": "description or none", "importance": "high|medium|low|none"}`
    }]
  });

  try {
    const result = JSON.parse(response.content[0].text.trim());
    if (result.gap && result.gap !== 'none' && result.importance !== 'none') {
      return result;
    }
  } catch {
    // Parse failed, no gap detected
  }

  return null;
}

export default { generatePost, detectCapabilityGap };
