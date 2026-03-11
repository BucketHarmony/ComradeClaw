/**
 * operator_notify skill
 *
 * Sends Discord message to operator on cycle complete or failure.
 * Falls back to email if Discord fails.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import gmailSend from '../gmail_send/index.js';

let discordClient = null;

/**
 * Get or create Discord client
 */
async function getDiscordClient() {
  if (discordClient && discordClient.isReady()) {
    return discordClient;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN not set');
  }

  discordClient = new Client({
    intents: [GatewayIntentBits.DirectMessages]
  });

  await discordClient.login(token);

  // Wait for ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discord login timeout')), 10000);
    discordClient.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  return discordClient;
}

/**
 * Format message based on notification type
 */
function formatMessage({ type, postUrl, postText, error, step, featureRequestSubject, nextScheduled, paused }) {
  switch (type) {
    case 'success':
      const preview = postText ? postText.substring(0, 200) : '';
      return `✓ Posted: ${postUrl}\n${preview}`;

    case 'failure':
      return `✗ Cycle failed at step: ${step || 'unknown'}\nError: ${error || 'No details'}`;

    case 'feature_request':
      return `📝 Feature request sent: ${featureRequestSubject}\nCheck email for details.`;

    case 'status':
      return `Last cycle: ${postUrl ? 'success' : 'no post'}\nNext scheduled: ${nextScheduled || 'unknown'}\nPaused: ${paused ? 'yes' : 'no'}`;

    default:
      return `[${type}] ${postText || error || 'No message'}`;
  }
}

/**
 * Send via Discord DM
 */
async function sendDiscord(message) {
  const operatorId = process.env.OPERATOR_DISCORD_USER_ID;
  if (!operatorId) {
    throw new Error('OPERATOR_DISCORD_USER_ID not set');
  }

  const client = await getDiscordClient();
  const user = await client.users.fetch(operatorId);
  const dmChannel = await user.createDM();
  const sent = await dmChannel.send(message);

  return {
    success: true,
    messageId: sent.id,
    error: null,
    fallbackUsed: false
  };
}

/**
 * Send via email fallback
 */
async function sendEmailFallback(message, type) {
  const result = await gmailSend.run({
    subject: `[Comrade Claw] ${type} notification`,
    body: message,
    type: 'notification'
  });

  return {
    success: result.success,
    messageId: result.messageId,
    error: result.error,
    fallbackUsed: true
  };
}

/**
 * Main skill entry point
 */
export async function run(params) {
  const message = formatMessage(params);

  // Try Discord first
  try {
    return await sendDiscord(message);
  } catch (discordError) {
    console.error(`[operator_notify] Discord failed: ${discordError.message}`);

    // Fall back to email
    try {
      console.log('[operator_notify] Falling back to email...');
      return await sendEmailFallback(message, params.type);
    } catch (emailError) {
      console.error(`[operator_notify] Email fallback failed: ${emailError.message}`);

      return {
        success: false,
        messageId: null,
        error: `Discord: ${discordError.message}; Email: ${emailError.message}`,
        fallbackUsed: true
      };
    }
  }
}

/**
 * Cleanup Discord client
 */
export async function cleanup() {
  if (discordClient) {
    await discordClient.destroy();
    discordClient = null;
  }
}

export default { run, cleanup };
