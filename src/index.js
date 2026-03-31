/**
 * Comrade Claw — Main Entry Point
 *
 * Direct chat with the SOUL via Discord DM.
 * Five scheduled wakes per day for autonomous operation.
 */

import 'dotenv/config';
// Clear API key so Claude Code CLI uses Max plan subscription auth instead
process.env.ANTHROPIC_API_KEY = '';

import { Client, GatewayIntentBits, Events, Partials } from 'discord.js';
import { handleOperatorCommand } from './commands.js';
import { startScheduler, setDiscordClient, setChatProcessing } from './scheduler.js';

let discordClient = null;

/**
 * Initialize Discord client for operator commands
 */
async function initDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const operatorId = process.env.OPERATOR_DISCORD_USER_ID;

  if (!token) {
    console.log('[main] No DISCORD_BOT_TOKEN — operator commands disabled');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  // Dedup guard — Discord can fire MessageCreate twice for DMs
  const processedMessages = new Set();

  client.on(Events.MessageCreate, async (message) => {
    // Only respond to operator DMs
    if (message.author.bot) return;
    if (message.author.id !== operatorId) return;
    if (!message.channel.isDMBased()) return;

    // Skip duplicate events for the same message
    if (processedMessages.has(message.id)) {
      console.log(`[discord] DEDUP: skipping duplicate message ${message.id}`);
      return;
    }
    processedMessages.add(message.id);
    console.log(`[discord] Processing message ${message.id}: "${message.content.substring(0, 50)}"`);
    if (processedMessages.size > 100) {
      const oldest = [...processedMessages].slice(0, 50);
      oldest.forEach(id => processedMessages.delete(id));
    }

    // Mark chat as processing (queues any wakes that fire)
    setChatProcessing(true);

    try {
      const response = await handleOperatorCommand(message.content, {});

      if (response) {
        // Discord has 2000 char limit - split long messages
        const chunks = [];
        let remaining = response;
        while (remaining.length > 0) {
          if (remaining.length <= 1900) {
            chunks.push(remaining);
            break;
          }
          // Find a good break point (newline near 1900)
          let breakPoint = remaining.lastIndexOf('\n', 1900);
          if (breakPoint < 1000) breakPoint = 1900;
          chunks.push(remaining.substring(0, breakPoint));
          remaining = remaining.substring(breakPoint).trimStart();
        }

        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await message.reply(chunks[i]);
          } else {
            await message.channel.send(chunks[i]);
          }
        }
      }
    } finally {
      // Mark chat as done (processes any queued wakes)
      setChatProcessing(false);
    }
  });

  client.once(Events.ClientReady, async () => {
    console.log(`[main] Discord connected as ${client.user.tag}`);

    // Set Discord client for scheduler notifications
    setDiscordClient(client, operatorId);

    // Send startup DM to operator
    try {
      const user = await client.users.fetch(operatorId);
      await user.send('Comrade Claw online. Five wakes scheduled. Send `help` for commands.');
      console.log('[main] Sent startup DM to operator');
    } catch (err) {
      console.error(`[main] Could not DM operator: ${err.message}`);
    }
  });

  await client.login(token);
  return client;
}

/**
 * Main entry point
 */
async function main() {
  console.log('='.repeat(50));
  console.log('COMRADE CLAW v2.0');
  console.log('Claude Code Runtime + Scheduled Wakes');
  console.log('='.repeat(50));
  console.log('');

  // Initialize Discord
  discordClient = await initDiscord();

  // Start wake scheduler
  startScheduler();

  console.log('[main] Comrade Claw is running.');
  console.log('[main] Ready for chat via Discord DM.');
  console.log('[main] Five daily wakes scheduled.');
  console.log('');

  // Keep process alive
  process.on('SIGINT', async () => {
    console.log('\n[main] Shutting down...');
    if (discordClient) await discordClient.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[main] Received SIGTERM, shutting down...');
    if (discordClient) await discordClient.destroy();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('[main] Fatal error:', error);
  process.exit(1);
});
