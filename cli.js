#!/usr/bin/env node
/**
 * Comrade Claw CLI
 *
 * Direct chat with the SOUL via command line.
 * Uses shared persistent history from src/history.js.
 * All conversations logged to workspace/logs/chat/YYYY-MM-DD.md
 * Tools enabled for journal writing, memory updates, and posting.
 */

import 'dotenv/config';
import readline from 'readline';
import { chatWithChannel, clearHistory, getDayNumber } from './src/chat.js';
import { loadHistory, getContextMessages } from './src/history.js';

/**
 * Main CLI loop
 */
async function main() {
  console.log('='.repeat(50));
  console.log('COMRADE CLAW CLI');
  console.log('='.repeat(50));
  console.log('');

  // Get day number
  const dayNumber = await getDayNumber();
  console.log(`Day ${dayNumber}`);

  // Load history
  const history = await loadHistory();
  const contextCount = getContextMessages(history).length;
  console.log(`History: ${history.messages.length} total, ${contextCount} in context`);

  console.log('');
  console.log('Tools enabled: journal_write, memory_update, bluesky_post, web_search');
  console.log('');
  console.log('Type your message. Commands: /clear, /quit, /help');
  console.log('-'.repeat(50));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = () => {
    rl.question('You: ', async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // Commands
      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\nGoodbye.');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/clear') {
        await clearHistory();
        console.log('\nConversation cleared.\n');
        prompt();
        return;
      }

      if (trimmed === '/help') {
        console.log('\nCommands:');
        console.log('  /clear — Clear conversation history');
        console.log('  /quit  — Exit CLI');
        console.log('  /help  — Show this message');
        console.log('');
        console.log('Available tools (used by Claw automatically):');
        console.log('  journal_write  — Write a journal entry');
        console.log('  memory_update  — Update characters, threads, or theory');
        console.log('  bluesky_post   — Post to Bluesky (300 char limit)');
        console.log('  web_search     — Search for cooperative news, mutual aid, etc.');
        console.log('  read_memory    — Read memory files');
        console.log('  read_journal   — Read previous journal entries\n');
        prompt();
        return;
      }

      // Get response (using chatWithChannel with 'cli' channel)
      try {
        process.stdout.write('\nClaw: ');
        const response = await chatWithChannel(trimmed, 'cli');
        console.log(response);
        console.log('');
      } catch (error) {
        console.error(`\nError: ${error.message}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
