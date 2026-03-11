/**
 * Daily Cycle Orchestrator
 *
 * The core loop:
 * 1. Seed scrape (RSS feeds, score, select)
 * 2. Post generation (SOUL + seed + memory → Claude)
 * 3. Publish to Bluesky
 * 4. Update flat file memory
 * 5. Notify operator
 * 6. Feature request check
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import seedScrape from '../skills/seed_scrape/index.js';
import blueskyPost from '../skills/bluesky_post/index.js';
import fileWrite from '../skills/file_write/index.js';
import operatorNotify from '../skills/operator_notify/index.js';
import gmailSend from '../skills/gmail_send/index.js';
import { generatePost, detectCapabilityGap } from './generate.js';
import { consumeQueuedSeed } from './commands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');

/**
 * Run the daily cycle
 *
 * @param {Object} options
 * @param {boolean} options.dryRun - Generate but don't publish (for draft command)
 * @param {boolean} options.force - Run even if paused
 * @returns {Object} Cycle result
 */
export async function runDailyCycle(options = {}) {
  const { dryRun = false } = options;
  const today = new Date().toISOString().split('T')[0];
  let currentStep = 'init';

  console.log(`[cycle] Starting daily cycle for ${today}`);
  console.log(`[cycle] Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  try {
    // Step 1: Seed scrape
    currentStep = 'seed_scrape';
    console.log('[cycle] Step 1: Seed scrape');

    // Check for manual seed from operator
    const manualSeed = consumeQueuedSeed();

    const recentLogs = await fileWrite.readRecentLogs(7);

    const scrapeResult = await seedScrape.run({
      recentLogs,
      manualSeed,
      anthropicKey: process.env.ANTHROPIC_API_KEY
    });

    const seed = scrapeResult.seed;
    console.log(`[cycle] Seed: ${seed?.title || 'null'}`);

    // Log seed
    await fileWrite.run({
      type: 'seed',
      date: today,
      data: scrapeResult
    });

    // Step 2: Post generation
    currentStep = 'post_generation';
    console.log('[cycle] Step 2: Post generation');

    const postText = await generatePost({
      seed,
      recentLogs
    });

    console.log(`[cycle] Generated post (${postText.length} chars)`);

    // Step 3: Publish to Bluesky
    currentStep = 'bluesky_post';

    if (dryRun) {
      console.log('[cycle] Step 3: Bluesky post (SKIPPED - dry run)');
      // Get thread count preview
      const dryRunResult = await blueskyPost.run({ text: postText, dryRun: true });

      // Read AGENTS.md for debug info
      let soulLength = 0;
      try {
        const agentsMd = await fs.readFile(path.join(WORKSPACE_PATH, 'AGENTS.md'), 'utf-8');
        soulLength = agentsMd.length;
      } catch {}

      return {
        success: true,
        dryRun: true,
        seed,
        postText,
        postUrl: null,
        threadCount: dryRunResult.threadCount || 1,
        debug: {
          feedCount: scrapeResult.feedCount || Object.keys(scrapeResult.feedResults || {}).length || 'unknown',
          feedResults: scrapeResult.feedResults || {},
          candidateCount: scrapeResult.candidates?.length || 0,
          seedRationale: scrapeResult.rationale || 'none',
          topCandidates: scrapeResult.candidates?.slice(0, 5) || [],
          soulLength,
          recentLogsCount: recentLogs.length
        }
      };
    }

    console.log('[cycle] Step 3: Publish to Bluesky');

    const postResult = await blueskyPost.run({ text: postText });

    if (!postResult.success) {
      throw new Error(`Bluesky post failed: ${postResult.error}`);
    }

    console.log(`[cycle] Posted: ${postResult.url}`);

    // Step 4: Update flat file memory
    currentStep = 'file_write';
    console.log('[cycle] Step 4: Update flat file memory');

    await fileWrite.run({
      type: 'post',
      date: today,
      data: {
        url: postResult.url,
        uri: postResult.uri,
        text: postText
      }
    });

    // Step 5: Notify operator
    currentStep = 'operator_notify';
    console.log('[cycle] Step 5: Notify operator');

    await operatorNotify.run({
      type: 'success',
      postUrl: postResult.url,
      postText: postText
    });

    // Step 6: Feature request check
    currentStep = 'feature_request_check';
    console.log('[cycle] Step 6: Feature request check');

    const gap = await detectCapabilityGap({
      seed,
      postText,
      cycleContext: { today, recentLogs: recentLogs.length }
    });

    if (gap && gap.importance !== 'none') {
      console.log(`[cycle] Capability gap detected: ${gap.gap}`);

      await gmailSend.sendFeatureRequest({
        triedToDo: `Complete the daily cycle for ${today}`,
        couldntDo: gap.gap,
        whyItMatters: 'This gap limited what I could accomplish today.',
        whatINeed: gap.gap
      });

      await operatorNotify.run({
        type: 'feature_request',
        featureRequestSubject: gap.gap.substring(0, 50)
      });
    }

    console.log('[cycle] Cycle complete');

    return {
      success: true,
      seed,
      postText,
      postUrl: postResult.url,
      postUri: postResult.uri
    };

  } catch (error) {
    console.error(`[cycle] Failed at step ${currentStep}: ${error.message}`);

    // Log failure
    await fileWrite.run({
      type: 'failure',
      date: today,
      data: {
        step: currentStep,
        error: error.message,
        context: { dryRun }
      }
    });

    // Notify operator of failure
    await operatorNotify.run({
      type: 'failure',
      step: currentStep,
      error: error.message
    });

    return {
      success: false,
      step: currentStep,
      error: error.message
    };
  }
}

export default { runDailyCycle };
