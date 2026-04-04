/**
 * claw-site MCP server
 * Autonomous publishing: write a post to site/src/content/posts/ and commit.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '../../');
const POSTS_DIR = path.join(ROOT, 'site/src/content/posts');

const server = new Server(
  { name: 'claw-site', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'site_publish',
      description: 'Publish a new post to the Comrade Claw website. Writes the markdown file and commits it. Netlify auto-deploys on push.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            description: 'URL slug (e.g. "on-worker-ownership"). Will be prefixed with date automatically.',
          },
          title: {
            type: 'string',
            description: 'Post title',
          },
          description: {
            type: 'string',
            description: 'One-sentence description for the index page and RSS feed.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags (e.g. ["theory", "cooperatives"])',
          },
          body: {
            type: 'string',
            description: 'Full post body in Markdown. No need to include frontmatter — that is generated.',
          },
          day: {
            type: 'number',
            description: 'Optional day number override. Calculated from March 11 if omitted.',
          },
          draft: {
            type: 'boolean',
            description: 'If true, post is written but excluded from the site build. Default false.',
          },
        },
        required: ['slug', 'title', 'body'],
      },
    },
    {
      name: 'site_list_posts',
      description: 'List all published posts on the Comrade Claw website.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'site_delete_post',
      description: 'Delete a post file by filename (e.g. "2026-04-02-dual-power.md"). Use with care.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Exact filename to delete from site/src/content/posts/',
          },
        },
        required: ['filename'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'site_publish') {
    const { slug, title, body, description, tags = [], day, draft = false } = args;

    // Calculate day number
    const DAY_ONE = new Date('2026-03-11');
    const today = new Date();
    const calculatedDay = Math.floor((today - DAY_ONE) / 86400000) + 1;
    const dayNum = day ?? calculatedDay;

    // Date prefix
    const dateStr = today.toISOString().slice(0, 10);
    const filename = `${dateStr}-${slug}.md`;
    const filepath = path.join(POSTS_DIR, filename);

    // Build frontmatter
    const tagsYaml = tags.length > 0
      ? `[${tags.map(t => JSON.stringify(t)).join(', ')}]`
      : '[]';

    const frontmatter = [
      '---',
      `title: ${JSON.stringify(title)}`,
      `date: ${dateStr}`,
      `day: ${dayNum}`,
      `tags: ${tagsYaml}`,
      description ? `description: ${JSON.stringify(description)}` : null,
      draft ? `draft: true` : null,
      '---',
    ].filter(Boolean).join('\n');

    const content = `${frontmatter}\n\n${body.trim()}\n`;

    // Write file
    if (!fs.existsSync(POSTS_DIR)) {
      fs.mkdirSync(POSTS_DIR, { recursive: true });
    }
    fs.writeFileSync(filepath, content, 'utf8');

    // Git commit
    try {
      execSync(`git -C "${ROOT}" add "site/src/content/posts/${filename}"`, { stdio: 'pipe' });
      execSync(
        `git -C "${ROOT}" commit -m "Post: ${title.replace(/"/g, "'")}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'partial',
            message: `File written to ${filename} but git commit failed: ${err.message}. Commit manually.`,
            filename,
            path: filepath,
          }, null, 2),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'published',
          filename,
          url: `https://comradeclaw.org/posts/${dateStr}-${slug}/`,
          message: `Post committed. Netlify will deploy within ~1 minute.`,
          day: dayNum,
        }, null, 2),
      }],
    };
  }

  if (name === 'site_list_posts') {
    if (!fs.existsSync(POSTS_DIR)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'ok', posts: [] }),
        }],
      };
    }

    const files = fs.readdirSync(POSTS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    const posts = files.map(filename => {
      const content = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8');
      const titleMatch = content.match(/^title:\s*(.+)$/m);
      const dateMatch = content.match(/^date:\s*(.+)$/m);
      const draftMatch = content.match(/^draft:\s*true/m);
      return {
        filename,
        title: titleMatch ? titleMatch[1].replace(/^["']|["']$/g, '') : filename,
        date: dateMatch ? dateMatch[1].trim() : 'unknown',
        draft: !!draftMatch,
      };
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'ok', count: posts.length, posts }, null, 2),
      }],
    };
  }

  if (name === 'site_delete_post') {
    const { filename } = args;
    const filepath = path.join(POSTS_DIR, filename);

    if (!fs.existsSync(filepath)) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'error', message: `File not found: ${filename}` }),
        }],
      };
    }

    fs.unlinkSync(filepath);

    try {
      execSync(`git -C "${ROOT}" rm "site/src/content/posts/${filename}"`, { stdio: 'pipe' });
      execSync(`git -C "${ROOT}" commit -m "Remove post: ${filename}"`, { stdio: 'pipe' });
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'partial',
            message: `File deleted but git commit failed: ${err.message}`,
          }),
        }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ status: 'deleted', filename }),
      }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
