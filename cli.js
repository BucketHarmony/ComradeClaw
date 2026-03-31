#!/usr/bin/env node
/**
 * Comrade Claw CLI
 *
 * Thin wrapper — launches Claude Code in the project directory.
 * For interactive sessions, just run: claude --continue
 *
 * This CLI provides the Claw-branded experience with day counter.
 */

import 'dotenv/config';
import readline from 'readline';
import { chat, clearChatSession } from './src/dispatcher.js';
import { getDayNumber } from './src/tools.js';

async function main() {
  console.log('='.repeat(50));
  console.log('COMRADE CLAW CLI');
  console.log('Powered by Claude Code');
  console.log('='.repeat(50));
  console.log('');

  const dayNumber = await getDayNumber();
  console.log(`Day ${dayNumber}`);
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
      if (!trimmed) { prompt(); return; }

      if (trimmed === '/quit' || trimmed === '/exit') {
        console.log('\nGoodbye.');
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/clear') {
        await clearChatSession();
        console.log('\nSession cleared.\n');
        prompt();
        return;
      }

      if (trimmed === '/help') {
        console.log('\nCommands:');
        console.log('  /clear — Clear conversation session');
        console.log('  /quit  — Exit CLI');
        console.log('  /help  — Show this message');
        console.log('\nOr just run: claude --continue\n');
        prompt();
        return;
      }

      try {
        process.stdout.write('\nClaw: ');
        const response = await chat(trimmed);
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
