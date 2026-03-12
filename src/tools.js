/**
 * AI Tools Module
 *
 * Tools available to Comrade Claw during conversations.
 * Each tool is exposed to Claude via the tools API.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const MEMORY_PATH = path.join(WORKSPACE_PATH, 'memory');
const JOURNAL_PATH = path.join(WORKSPACE_PATH, 'logs', 'journal');
const BLUESKY_PATH = path.join(WORKSPACE_PATH, 'bluesky');
const LAST_SEEN_PATH = path.join(BLUESKY_PATH, 'last_seen.json');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');

// Day 1 start date - March 11, 2026
const DAY_ONE = new Date('2026-03-11T00:00:00');

/**
 * Shared Bluesky agent login — DRY helper for all Bluesky tools
 * Returns { agent } on success or { error } if credentials missing/login fails
 */
async function getBlueskyAgent() {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !password) {
    return { error: 'Bluesky credentials (BLUESKY_HANDLE, BLUESKY_APP_PASSWORD) not set in environment.' };
  }

  try {
    const { BskyAgent } = await import('@atproto/api');
    const agent = new BskyAgent({ service: 'https://bsky.social' });
    await agent.login({ identifier: handle, password: password });
    return { agent };
  } catch (err) {
    return { error: `Bluesky login failed: ${err.message}` };
  }
}

/**
 * Notification state tracking — last-seen timestamp for read_replies
 */
async function getLastSeenTimestamp() {
  try {
    const data = await fs.readFile(LAST_SEEN_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed.lastSeen || null;
  } catch {
    return null;
  }
}

async function saveLastSeenTimestamp(timestamp) {
  await fs.mkdir(BLUESKY_PATH, { recursive: true });
  await fs.writeFile(LAST_SEEN_PATH, JSON.stringify({ lastSeen: timestamp }, null, 2));
}

/**
 * Get current day number based on calendar days since start
 */
export async function getDayNumber() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffTime = startOfToday - DAY_ONE;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return diffDays + 1; // Day 1 = start date
}

/**
 * Get today's journal entry count (for multiple entries per day)
 */
async function getTodayEntryCount() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const files = await fs.readdir(JOURNAL_PATH);
    const todayFiles = files.filter(f => f.startsWith(today) && f.endsWith('.md'));
    return todayFiles.length;
  } catch {
    return 0;
  }
}

/**
 * Tool definitions for Claude API
 */
export const toolDefinitions = [
  {
    name: 'web_search',
    description: 'Search the web for cooperative launches, mutual aid wins, free pantries, theory, labor organizing, and local things that matter. Returns search results with titles, snippets, and URLs.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Be specific: "worker cooperative launch 2026", "mutual aid network Michigan", "free pantry still running"'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'journal_write',
    description: 'Write a journal entry. This is the core creative act. The entry is saved to logs/journal/ with a timestamp. Multiple entries per day are allowed. The entry becomes part of your permanent record.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The full journal entry in markdown. Follow the SOUL guidance: Intro, Attempt, Result, Reflection, Low, High, Will — but only the sections the day earns.'
        },
        title: {
          type: 'string',
          description: 'Optional title for the entry. If not provided, will use "Day N" format.'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'memory_update',
    description: 'Update one of the memory files: characters (people who became real), threads (situations developing), or theory (positions evolved). This is how you maintain continuity.',
    input_schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['characters', 'threads', 'theory'],
          description: 'Which memory file to update'
        },
        action: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'append: add new content at the end. replace: rewrite the entire file.'
        },
        content: {
          type: 'string',
          description: 'The content to add or replace. Use markdown formatting.'
        }
      },
      required: ['file', 'action', 'content']
    }
  },
  {
    name: 'bluesky_post',
    description: 'Post to Bluesky. 300 character limit. Use for excerpts, thoughts that stand alone, links to journal entries. This is distribution, not the journal itself.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The post text. Maximum 300 characters. Should stand alone as a thought, not be a summary.'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'read_memory',
    description: 'Read one of the memory files to see current characters, threads, or theory notes.',
    input_schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          enum: ['characters', 'threads', 'theory'],
          description: 'Which memory file to read'
        }
      },
      required: ['file']
    }
  },
  {
    name: 'read_journal',
    description: 'Read previous journal entries. Returns the last N entries for context and continuity.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent entries to read. Default 2, max 10.'
        }
      }
    }
  },
  {
    name: 'read_replies',
    description: 'See who is talking to you on Bluesky. Returns replies, mentions, and quotes with context about which of your posts they responded to. New notifications only unless include_read is true.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max notifications to fetch. Default 25, max 50.'
        },
        include_read: {
          type: 'boolean',
          description: 'Include already-seen notifications. Default false.'
        }
      }
    }
  },
  {
    name: 'bluesky_reply',
    description: 'Reply to someone on Bluesky. 300 character limit. Reply when there is something to say, not to perform engagement. The uri comes from read_replies output.',
    input_schema: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'The AT URI of the post to reply to (from read_replies output).'
        },
        text: {
          type: 'string',
          description: 'The reply text. Maximum 300 characters.'
        }
      },
      required: ['uri', 'text']
    }
  },
  {
    name: 'send_email',
    description: 'Send an email. Defaults to the operator. Use for feature requests, leads worth forwarding, or anything that needs to leave the feed.',
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address. Defaults to OPERATOR_EMAIL if not provided.'
        },
        subject: {
          type: 'string',
          description: 'Email subject line.'
        },
        body: {
          type: 'string',
          description: 'Email body text.'
        }
      },
      required: ['subject', 'body']
    }
  },
  {
    name: 'read_email',
    description: 'Check your inbox. Leads, tips, replies to things you sent. Not every email needs a response.',
    input_schema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of recent emails to fetch. Default 5, max 20.'
        },
        unseen_only: {
          type: 'boolean',
          description: 'Only return unread emails. Default true.'
        }
      }
    }
  }
];

/**
 * plan_wake tool definition — used only by the planner, not in the main toolDefinitions array.
 * Exported separately so the orchestrator can provide it to the planner call.
 */
export const planWakeTool = {
  name: 'plan_wake',
  description: 'Create your plan for this wake. List the tasks you want to accomplish, in order. Each task will be executed in a focused session with only the tools it needs.',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['check_inbox', 'respond', 'search', 'journal', 'distribute', 'memory', 'send_email', 'nothing'],
              description: 'The type of task to perform.'
            },
            reason: {
              type: 'string',
              description: 'Why you want to do this task at this wake.'
            },
            intent: {
              type: 'string',
              description: 'Specific intent — e.g. search query idea, who to reply to, what to write about.'
            }
          },
          required: ['type', 'reason']
        }
      }
    },
    required: ['tasks']
  }
};

/**
 * Execute a tool call
 */
export async function executeTool(toolName, toolInput) {
  console.log(`[tools] Executing: ${toolName}`);

  switch (toolName) {
    case 'web_search':
      return await executeWebSearch(toolInput);
    case 'journal_write':
      return await executeJournalWrite(toolInput);
    case 'memory_update':
      return await executeMemoryUpdate(toolInput);
    case 'bluesky_post':
      return await executeBlueskyPost(toolInput);
    case 'read_memory':
      return await executeReadMemory(toolInput);
    case 'read_journal':
      return await executeReadJournal(toolInput);
    case 'read_replies':
      return await executeReadReplies(toolInput);
    case 'bluesky_reply':
      return await executeBlueskyReply(toolInput);
    case 'send_email':
      return await executeSendEmail(toolInput);
    case 'read_email':
      return await executeReadEmail(toolInput);
    case 'plan_wake':
      return await executePlanWake(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Web search using Brave Search API
 * Free tier: 2000 queries/month
 * Set BRAVE_API_KEY in environment
 */
async function executeWebSearch({ query }) {
  console.log(`[tools] Web search: "${query}"`);

  const apiKey = process.env.BRAVE_API_KEY;

  if (!apiKey) {
    // Fallback message if no API key configured
    return {
      status: 'not_configured',
      query: query,
      message: 'Web search requires BRAVE_API_KEY. Get a free key at https://brave.com/search/api/ (2000 queries/month free).',
      results: []
    };
  }

  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '10');

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[tools] Brave Search error ${response.status}: ${errorText}`);
      return {
        status: 'error',
        query: query,
        message: `Search API error: ${response.status}`,
        results: []
      };
    }

    const data = await response.json();

    if (!data.web?.results || data.web.results.length === 0) {
      return {
        status: 'no_results',
        query: query,
        message: 'No results found. Try different search terms.',
        results: []
      };
    }

    // Return results with relevant fields
    const formatted = data.web.results.slice(0, 10).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description || '',
      age: r.age || null
    }));

    console.log(`[tools] Found ${formatted.length} results for "${query}"`);

    return {
      status: 'success',
      query: query,
      count: formatted.length,
      results: formatted
    };
  } catch (error) {
    console.error(`[tools] Web search error: ${error.message}`);
    return {
      status: 'error',
      query: query,
      message: error.message,
      results: []
    };
  }
}

/**
 * Write a journal entry
 */
async function executeJournalWrite({ content, title }) {
  await fs.mkdir(JOURNAL_PATH, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().replace(/[:.]/g, '-').substring(11, 19);
  const dayNumber = await getDayNumber();
  const todayCount = await getTodayEntryCount();

  // Filename: YYYY-MM-DD_HH-MM-SS.md (allows multiple per day)
  const filename = `${dateStr}_${timeStr}.md`;
  const filepath = path.join(JOURNAL_PATH, filename);

  const entryTitle = title || `Day ${dayNumber}${todayCount > 0 ? ` — Entry ${todayCount + 1}` : ''}`;
  const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

  const fullEntry = `# ${entryTitle}

*${timestamp}*

---

${content}
`;

  await fs.writeFile(filepath, fullEntry);
  console.log(`[tools] Journal entry written: ${filename}`);

  return {
    status: 'success',
    file: filename,
    path: filepath,
    day: dayNumber,
    title: entryTitle,
    wordCount: content.split(/\s+/).length
  };
}

/**
 * Update a memory file
 */
async function executeMemoryUpdate({ file, action, content }) {
  await fs.mkdir(MEMORY_PATH, { recursive: true });

  const filepath = path.join(MEMORY_PATH, `${file}.md`);
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

  if (action === 'append') {
    // Read existing content
    let existing = '';
    try {
      existing = await fs.readFile(filepath, 'utf-8');
    } catch {
      // File doesn't exist, that's fine
    }

    const newContent = `${existing}\n\n---\n\n*Updated: ${timestamp}*\n\n${content}`;
    await fs.writeFile(filepath, newContent);
  } else {
    // Replace entire file
    const header = file === 'characters'
      ? '# Ongoing Characters\n\n*Characters emerge from the work. When someone becomes real, add them here.*\n\n---\n'
      : file === 'threads'
      ? '# Open Threads\n\n*Situations that keep developing. Update after each cycle if threads evolve.*\n\n---\n'
      : '# Theory Notes\n\n*Positions that have evolved through the work. Update slowly.*\n\n---\n';

    await fs.writeFile(filepath, `${header}\n*Updated: ${timestamp}*\n\n${content}`);
  }

  console.log(`[tools] Memory updated: ${file}.md (${action})`);

  return {
    status: 'success',
    file: `${file}.md`,
    action: action,
    timestamp: timestamp
  };
}

/**
 * Post to Bluesky
 */
async function executeBlueskyPost({ text }) {
  if (text.length > 300) {
    return {
      status: 'error',
      message: `Post exceeds 300 character limit (${text.length} chars). Compress without truncating.`
    };
  }

  const { agent, error } = await getBlueskyAgent();
  if (error) {
    console.log(`[tools] Bluesky: ${error}`);
    return { status: 'not_configured', message: error, text, charCount: text.length };
  }

  try {
    const result = await agent.post({ text });
    console.log(`[tools] Posted to Bluesky: ${result.uri}`);
    return { status: 'success', uri: result.uri, cid: result.cid, text, charCount: text.length };
  } catch (err) {
    console.error(`[tools] Bluesky error: ${err.message}`);
    return { status: 'error', message: err.message, text };
  }
}

/**
 * Read a memory file
 */
async function executeReadMemory({ file }) {
  const filepath = path.join(MEMORY_PATH, `${file}.md`);

  try {
    const content = await fs.readFile(filepath, 'utf-8');
    return {
      status: 'success',
      file: `${file}.md`,
      content: content
    };
  } catch (error) {
    return {
      status: 'empty',
      file: `${file}.md`,
      content: `No ${file} recorded yet.`,
      message: error.code === 'ENOENT' ? 'File does not exist' : error.message
    };
  }
}

/**
 * Read recent journal entries
 */
async function executeReadJournal({ count = 2 }) {
  const limit = Math.min(Math.max(1, count), 10);

  try {
    await fs.mkdir(JOURNAL_PATH, { recursive: true });
    const files = await fs.readdir(JOURNAL_PATH);
    const journalFiles = files
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, limit);

    if (journalFiles.length === 0) {
      return {
        status: 'empty',
        message: 'No journal entries yet. This is Day 1.',
        entries: []
      };
    }

    const entries = [];
    for (const file of journalFiles) {
      const content = await fs.readFile(path.join(JOURNAL_PATH, file), 'utf-8');
      entries.push({
        file: file,
        content: content
      });
    }

    return {
      status: 'success',
      count: entries.length,
      entries: entries
    };
  } catch (error) {
    return {
      status: 'error',
      message: error.message,
      entries: []
    };
  }
}

/**
 * Read Bluesky replies, mentions, and quotes
 */
async function executeReadReplies({ limit = 25, include_read = false }) {
  const fetchLimit = Math.min(Math.max(1, limit), 50);

  const { agent, error } = await getBlueskyAgent();
  if (error) {
    return { status: 'not_configured', message: error };
  }

  try {
    const lastSeen = include_read ? null : await getLastSeenTimestamp();

    const response = await agent.listNotifications({ limit: fetchLimit });
    const notifications = response.data.notifications || [];

    // Filter to reply/mention/quote types only
    const relevant = notifications.filter(n =>
      ['reply', 'mention', 'quote'].includes(n.reason)
    );

    // Filter by last-seen timestamp if not including read
    const filtered = lastSeen
      ? relevant.filter(n => new Date(n.indexedAt) > new Date(lastSeen))
      : relevant;

    if (filtered.length === 0) {
      return {
        status: 'success',
        message: include_read
          ? 'No replies, mentions, or quotes found.'
          : 'No new replies since last check.',
        count: 0,
        formatted: ''
      };
    }

    // Format each notification with parent context
    const blocks = [];
    let newestTimestamp = lastSeen;

    for (const notif of filtered) {
      const ts = new Date(notif.indexedAt);
      if (!newestTimestamp || ts > new Date(newestTimestamp)) {
        newestTimestamp = notif.indexedAt;
      }

      const handle = notif.author.handle;
      const displayName = notif.author.displayName || handle;
      const dateStr = ts.toISOString().replace('T', ' ').substring(0, 16);
      const replyText = notif.record?.text || '[no text]';
      const replyUri = notif.uri;

      // Try to get parent post context for replies
      let parentLine = '';
      if (notif.reason === 'reply' && notif.record?.reply?.parent?.uri) {
        try {
          const parentThread = await agent.getPostThread({
            uri: notif.record.reply.parent.uri,
            depth: 0,
            parentHeight: 0
          });
          const parentText = parentThread.data.thread?.post?.record?.text || '';
          if (parentText) {
            const snippet = parentText.length > 100
              ? parentText.substring(0, 100) + '...'
              : parentText;
            parentLine = `Replying to your post: "${snippet}"`;
          }
        } catch {
          parentLine = 'Replying to your post (could not fetch text)';
        }
      } else if (notif.reason === 'mention') {
        parentLine = 'Mentioned you';
      } else if (notif.reason === 'quote') {
        parentLine = 'Quoted your post';
      }

      const block = [
        `@${handle} (${displayName}) — ${dateStr}`,
        parentLine,
        `"${replyText}"`,
        `[Reply URI: ${replyUri}]`
      ].filter(Boolean).join('\n');

      blocks.push(block);
    }

    // Save newest timestamp
    if (newestTimestamp && !include_read) {
      await saveLastSeenTimestamp(newestTimestamp);
    }

    const formatted = blocks.join('\n\n---\n\n');
    console.log(`[tools] Read ${filtered.length} Bluesky notifications`);

    return {
      status: 'success',
      count: filtered.length,
      formatted: formatted
    };
  } catch (err) {
    console.error(`[tools] read_replies error: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

/**
 * Reply to a post on Bluesky
 */
async function executeBlueskyReply({ uri, text }) {
  if (text.length > 300) {
    return {
      status: 'error',
      message: `Reply exceeds 300 character limit (${text.length} chars). Compress without truncating.`
    };
  }

  const { agent, error } = await getBlueskyAgent();
  if (error) {
    return { status: 'not_configured', message: error };
  }

  try {
    // Fetch the thread to get the post we're replying to and find the root
    const thread = await agent.getPostThread({ uri, depth: 0, parentHeight: 10 });
    const replyTo = thread.data.thread?.post;

    if (!replyTo) {
      return { status: 'error', message: 'Could not find the post to reply to.' };
    }

    // Walk up to find root post
    let root = thread.data.thread;
    while (root.parent?.post) {
      root = root.parent;
    }

    const replyRef = {
      root: {
        uri: root.post.uri,
        cid: root.post.cid
      },
      parent: {
        uri: replyTo.uri,
        cid: replyTo.cid
      }
    };

    const result = await agent.post({ text, reply: replyRef });
    console.log(`[tools] Replied on Bluesky: ${result.uri}`);

    return {
      status: 'success',
      uri: result.uri,
      cid: result.cid,
      inReplyTo: uri,
      text,
      charCount: text.length
    };
  } catch (err) {
    console.error(`[tools] bluesky_reply error: ${err.message}`);
    return { status: 'error', message: err.message, text };
  }
}

/**
 * Send an email via Gmail SMTP
 */
async function executeSendEmail({ to, subject, body }) {
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
  const operatorEmail = process.env.OPERATOR_EMAIL;

  if (!gmailAddress || !gmailAppPassword) {
    return {
      status: 'not_configured',
      message: 'Gmail credentials (GMAIL_ADDRESS, GMAIL_APP_PASSWORD) not set in environment.'
    };
  }

  const recipient = to || operatorEmail;
  if (!recipient) {
    return {
      status: 'error',
      message: 'No recipient specified and OPERATOR_EMAIL not set.'
    };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      service: 'gmail',
      auth: {
        user: gmailAddress,
        pass: gmailAppPassword
      }
    });

    const info = await transporter.sendMail({
      from: `Comrade Claw <${gmailAddress}>`,
      to: recipient,
      subject,
      text: body
    });

    console.log(`[tools] Email sent: ${info.messageId}`);
    return {
      status: 'success',
      messageId: info.messageId,
      message: `Email sent to ${recipient}`
    };
  } catch (err) {
    console.error(`[tools] send_email error: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

/**
 * Read emails from Gmail inbox via IMAP
 */
async function executeReadEmail({ count = 5, unseen_only = true }) {
  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailAddress || !gmailAppPassword) {
    return {
      status: 'not_configured',
      message: 'Gmail credentials (GMAIL_ADDRESS, GMAIL_APP_PASSWORD) not set in environment.'
    };
  }

  const limit = Math.min(Math.max(1, count), 20);

  let client;
  try {
    const { ImapFlow } = await import('imapflow');
    client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: gmailAddress,
        pass: gmailAppPassword
      },
      logger: false
    });

    await client.connect();

    const lock = await client.getMailboxLock('INBOX');
    try {
      // Build search criteria
      const searchCriteria = unseen_only ? { seen: false } : { all: true };
      const uids = await client.search(searchCriteria);

      if (uids.length === 0) {
        return {
          status: 'success',
          count: 0,
          message: unseen_only ? 'No unread emails.' : 'Inbox is empty.',
          formatted: ''
        };
      }

      // Take the most recent N UIDs
      const recentUids = uids.slice(-limit).reverse();
      const emails = [];

      for (const uid of recentUids) {
        const message = await client.fetchOne(uid, {
          envelope: true,
          source: true
        }, { uid: true });

        if (!message) continue;

        const env = message.envelope;
        const fromAddr = env.from?.[0];
        const fromStr = fromAddr
          ? `${fromAddr.address}${fromAddr.name ? ` (${fromAddr.name})` : ''}`
          : 'unknown';
        const dateStr = env.date
          ? new Date(env.date).toISOString().replace('T', ' ').substring(0, 16)
          : 'unknown date';
        const subject = env.subject || '(no subject)';

        // Extract plain text body from source
        let bodyText = '';
        if (message.source) {
          const raw = message.source.toString();
          // Simple plain-text extraction: find the text/plain part
          // For multipart, look for text/plain content
          const plainMatch = raw.match(/Content-Type: text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:[^\r\n]*\r?\n)?(?:[^\r\n]*\r?\n)*?\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\.\r?\n|$)/i);
          if (plainMatch) {
            bodyText = plainMatch[1].trim();
          } else {
            // Fallback: grab everything after the headers
            const headerEnd = raw.indexOf('\r\n\r\n');
            if (headerEnd !== -1) {
              bodyText = raw.substring(headerEnd + 4).trim();
            }
          }
          // Strip HTML tags if we accidentally got HTML
          bodyText = bodyText.replace(/<[^>]+>/g, '');
          // Truncate
          if (bodyText.length > 500) {
            bodyText = bodyText.substring(0, 500) + '...';
          }
        }

        emails.push(`From: ${fromStr} — ${dateStr}\nSubject: ${subject}\n"${bodyText}"`);
      }

      const formatted = emails.join('\n\n---\n\n');
      console.log(`[tools] Read ${emails.length} emails from inbox`);

      return {
        status: 'success',
        count: emails.length,
        formatted
      };
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[tools] read_email error: ${err.message}`);
    return { status: 'error', message: err.message };
  } finally {
    if (client) {
      await client.logout().catch(() => {});
    }
  }
}

// Module-level state for plan_wake — set by orchestrator before planner runs
let _planWakeContext = null;

/**
 * Set wake context for the plan_wake tool executor.
 * Called by the orchestrator before running the planner.
 */
export function setPlanWakeContext(context) {
  _planWakeContext = context;
}

/**
 * Save a wake plan to workspace/plans/
 */
export async function savePlan(plan) {
  await fs.mkdir(PLANS_PATH, { recursive: true });
  const filename = `${plan.date || new Date().toISOString().split('T')[0]}_${plan.wake}.json`;
  const filepath = path.join(PLANS_PATH, filename);
  await fs.writeFile(filepath, JSON.stringify(plan, null, 2));
  return filepath;
}

/**
 * Read a plan file
 */
export async function readPlan(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Get the latest plan file path (most recent by filename sort)
 */
export async function getLatestPlanPath() {
  try {
    await fs.mkdir(PLANS_PATH, { recursive: true });
    const files = await fs.readdir(PLANS_PATH);
    const planFiles = files.filter(f => f.endsWith('.json')).sort().reverse();
    if (planFiles.length === 0) return null;
    return path.join(PLANS_PATH, planFiles[0]);
  } catch {
    return null;
  }
}

/**
 * Execute plan_wake tool — creates the wake plan
 */
async function executePlanWake({ tasks }) {
  if (!_planWakeContext) {
    return { status: 'error', message: 'No wake context set. This tool is only available during wake planning.' };
  }

  const { label, time, dayNumber } = _planWakeContext;
  const date = new Date().toISOString().split('T')[0];

  const plan = {
    wake: label,
    time: time,
    day: dayNumber,
    date: date,
    created: new Date().toISOString(),
    status: 'in_progress',
    tasks: tasks.map((t, i) => ({
      id: i + 1,
      type: t.type,
      status: 'pending',
      reason: t.reason,
      intent: t.intent || null,
      summary: null
    }))
  };

  const filepath = await savePlan(plan);
  console.log(`[tools] Wake plan saved: ${filepath} (${tasks.length} tasks)`);

  // Clear context after use
  _planWakeContext = null;

  return {
    status: 'success',
    path: filepath,
    taskCount: tasks.length,
    tasks: plan.tasks.map(t => `${t.id}. ${t.type}: ${t.reason}`)
  };
}

/**
 * Load memory files for prompt injection
 */
export async function loadMemoryForPrompt() {
  const memory = {
    characters: '',
    threads: '',
    theory: ''
  };

  for (const file of ['characters', 'threads', 'theory']) {
    try {
      memory[file] = await fs.readFile(path.join(MEMORY_PATH, `${file}.md`), 'utf-8');
    } catch {
      memory[file] = `*No ${file} recorded yet.*`;
    }
  }

  return memory;
}

/**
 * Load recent journal entries for prompt injection
 */
export async function loadRecentJournals(count = 2) {
  try {
    await fs.mkdir(JOURNAL_PATH, { recursive: true });
    const files = await fs.readdir(JOURNAL_PATH);
    const journalFiles = files
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, count);

    const entries = [];
    for (const file of journalFiles) {
      const content = await fs.readFile(path.join(JOURNAL_PATH, file), 'utf-8');
      entries.push(content);
    }

    return entries;
  } catch {
    return [];
  }
}

export default {
  toolDefinitions,
  planWakeTool,
  executeTool,
  getDayNumber,
  loadMemoryForPrompt,
  loadRecentJournals,
  setPlanWakeContext,
  savePlan,
  readPlan,
  getLatestPlanPath
};
