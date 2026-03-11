/**
 * file_write skill
 *
 * Writes logs and updates workspace files after each cycle.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', '..', 'workspace');

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

/**
 * Write seed log
 */
async function writeSeedLog(date, data) {
  const dirPath = path.join(WORKSPACE_PATH, 'logs', 'seeds');
  await ensureDir(dirPath);

  const filePath = path.join(dirPath, `${date}.json`);
  const content = JSON.stringify({
    date,
    seed: data.seed,
    candidates: data.candidates || [],
    rationale: data.rationale || null
  }, null, 2);

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`[file_write] Wrote seed log: ${filePath}`);

  return { filePath };
}

/**
 * Write post log
 */
async function writePostLog(date, data) {
  const dirPath = path.join(WORKSPACE_PATH, 'logs', 'posts');
  await ensureDir(dirPath);

  const filePath = path.join(dirPath, `${date}.txt`);
  const content = `URL: ${data.url || 'none'}
URI: ${data.uri || 'none'}

${data.text || '(no text)'}
`;

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`[file_write] Wrote post log: ${filePath}`);

  return { filePath };
}

/**
 * Write failure log
 */
async function writeFailureLog(date, data) {
  const dirPath = path.join(WORKSPACE_PATH, 'logs', 'failures');
  await ensureDir(dirPath);

  const filePath = path.join(dirPath, `${date}.json`);
  const content = JSON.stringify({
    date,
    step: data.step,
    error: data.error,
    context: data.context || {}
  }, null, 2);

  await fs.writeFile(filePath, content, 'utf-8');
  console.log(`[file_write] Wrote failure log: ${filePath}`);

  return { filePath };
}

/**
 * Update AGENTS.md memory section
 */
async function updateMemory(data) {
  const filePath = path.join(WORKSPACE_PATH, 'AGENTS.md');

  // Read current content
  let content;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    console.error(`[file_write] Could not read AGENTS.md: ${error.message}`);
    return { error: error.message };
  }

  // Find the appropriate section and append
  const { section, entry } = data;
  const sectionHeaders = {
    characters: '### Ongoing Characters',
    threads: '### Open Threads',
    theory: '### Theory Notes'
  };

  const header = sectionHeaders[section];
  if (!header) {
    return { error: `Unknown section: ${section}` };
  }

  const headerIndex = content.indexOf(header);
  if (headerIndex === -1) {
    return { error: `Section not found: ${header}` };
  }

  // Find end of section (next ### or end of file)
  const afterHeader = content.indexOf('\n', headerIndex) + 1;
  let nextSection = content.indexOf('\n###', afterHeader);
  if (nextSection === -1) nextSection = content.length;

  // Insert entry before next section
  const before = content.substring(0, nextSection);
  const after = content.substring(nextSection);
  const newContent = before.trimEnd() + '\n\n' + entry + '\n' + after;

  await fs.writeFile(filePath, newContent, 'utf-8');
  console.log(`[file_write] Updated AGENTS.md section: ${section}`);

  return { filePath };
}

/**
 * Read recent session logs for context
 */
export async function readRecentLogs(count = 7) {
  const seedsDir = path.join(WORKSPACE_PATH, 'logs', 'seeds');
  const postsDir = path.join(WORKSPACE_PATH, 'logs', 'posts');

  const logs = [];

  try {
    const seedFiles = await fs.readdir(seedsDir);
    const sortedFiles = seedFiles
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, count);

    for (const file of sortedFiles) {
      try {
        const seedContent = await fs.readFile(path.join(seedsDir, file), 'utf-8');
        const seed = JSON.parse(seedContent);

        const date = file.replace('.json', '');
        let postText = null;

        try {
          const postContent = await fs.readFile(path.join(postsDir, `${date}.txt`), 'utf-8');
          // Extract just the post text (after the URL/URI headers)
          const lines = postContent.split('\n');
          postText = lines.slice(3).join('\n').trim();
        } catch {
          // Post file may not exist
        }

        logs.push({
          date,
          seed: seed.seed,
          postText
        });
      } catch (error) {
        console.error(`[file_write] Error reading log ${file}: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[file_write] Error reading logs directory: ${error.message}`);
  }

  return logs;
}

/**
 * Main skill entry point
 */
export async function run({ type, date, data }) {
  const today = date || new Date().toISOString().split('T')[0];

  try {
    switch (type) {
      case 'seed':
        return { success: true, ...(await writeSeedLog(today, data)) };

      case 'post':
        return { success: true, ...(await writePostLog(today, data)) };

      case 'failure':
        return { success: true, ...(await writeFailureLog(today, data)) };

      case 'memory':
        return { success: true, ...(await updateMemory(data)) };

      default:
        return { success: false, error: `Unknown type: ${type}` };
    }
  } catch (error) {
    console.error(`[file_write] Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export default { run, readRecentLogs };
