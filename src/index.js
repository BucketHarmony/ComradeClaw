/**
 * Comrade Claw — Main Entry Point
 *
 * Direct chat with the SOUL via Discord DM.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { handleOperatorCommand } from './commands.js';

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
    ]
  });

  client.on(Events.MessageCreate, async (message) => {
    // Only respond to operator DMs
    if (message.author.bot) return;
    if (message.author.id !== operatorId) return;
    if (!message.channel.isDMBased()) return;

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
  });

  client.once(Events.ClientReady, async () => {
    console.log(`[main] Discord connected as ${client.user.tag}`);

    // Send startup DM to operator
    try {
      const user = await client.users.fetch(operatorId);
      await user.send('Comrade Claw online. Send `help` for commands.');
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
  console.log('COMRADE CLAW v1.0');
  console.log('Direct Chat Mode');
  console.log('='.repeat(50));
  console.log('');

  // Initialize Discord
  discordClient = await initDiscord();

  console.log('[main] Comrade Claw is running.');
  console.log('[main] Ready for chat via Discord DM.');
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
