import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('@atproto/api', () => ({
  BskyAgent: class MockBskyAgent {
    constructor() {
      this.session = { did: 'did:plc:test123' };
    }
    async login() { return {}; }
    async post() { return { uri: 'at://test/post/1', cid: 'baf123' }; }
    async getAuthorFeed() {
      return {
        data: {
          feed: [{
            post: {
              record: { text: 'Hello world' },
              indexedAt: '2026-03-15T12:00:00Z',
              likeCount: 5, repostCount: 2, replyCount: 1, quoteCount: 0,
              uri: 'at://test/post/1'
            }
          }]
        }
      };
    }
    async listNotifications() {
      return {
        data: {
          notifications: [{
            reason: 'reply',
            author: { handle: 'friend.bsky.social', displayName: 'Friend' },
            indexedAt: '2026-03-15T14:00:00Z',
            record: { text: 'Great post!', reply: { parent: { uri: 'at://test/post/1' } } },
            uri: 'at://test/reply/1'
          }]
        }
      };
    }
    async getPostThread() {
      return {
        data: {
          thread: {
            post: { uri: 'at://test/post/1', cid: 'baf123', record: { text: 'Original post' } }
          }
        }
      };
    }
  }
}));

// Track registered tools
const registeredTools = [];

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    constructor() {}
    tool(name, desc, schema, handler) {
      registeredTools.push({ name, desc, schema, handler });
    }
    async connect() {}
  }
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockTransport { constructor() {} }
}));

process.env.BLUESKY_HANDLE = 'test.bsky.social';
process.env.BLUESKY_APP_PASSWORD = 'test-pass';

await import('../src/mcp/bluesky-server.js');

describe('bluesky MCP server', () => {
  describe('tool registration', () => {
    it('registers 4 tools', () => {
      expect(registeredTools.length).toBe(4);
    });

    it('registers bluesky_post', () => {
      const tool = registeredTools.find(t => t.name === 'bluesky_post');
      expect(tool).toBeDefined();
      expect(tool.desc).toContain('300 character limit');
    });

    it('registers bluesky_reply', () => {
      expect(registeredTools.find(t => t.name === 'bluesky_reply')).toBeDefined();
    });

    it('registers read_timeline', () => {
      const tool = registeredTools.find(t => t.name === 'read_timeline');
      expect(tool).toBeDefined();
      expect(tool.desc).toContain('engagement');
    });

    it('registers read_replies', () => {
      expect(registeredTools.find(t => t.name === 'read_replies')).toBeDefined();
    });
  });

  describe('bluesky_post handler', () => {
    it('rejects posts over 300 chars', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_post').handler;
      const result = await handler({ text: 'A'.repeat(301) });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
      expect(data.message).toContain('300 char');
    });

    it('posts successfully', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_post').handler;
      const result = await handler({ text: 'Test post' });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.uri).toBe('at://test/post/1');
      expect(data.charCount).toBe(9);
    });

    it('accepts exactly 300 chars', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_post').handler;
      const result = await handler({ text: 'X'.repeat(300) });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });
  });

  describe('bluesky_reply handler', () => {
    it('rejects replies over 300 chars', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_reply').handler;
      const result = await handler({ uri: 'at://test/post/1', text: 'B'.repeat(301) });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('error');
    });

    it('replies successfully', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_reply').handler;
      const result = await handler({ uri: 'at://test/post/1', text: 'Nice!' });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.inReplyTo).toBe('at://test/post/1');
    });
  });

  describe('read_timeline handler', () => {
    it('returns formatted timeline', async () => {
      const handler = registeredTools.find(t => t.name === 'read_timeline').handler;
      const result = await handler({ count: 10 });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.count).toBe(1);
      expect(data.formatted).toContain('Hello world');
      expect(data.formatted).toContain('Likes: 5');
      expect(data.formatted).toContain('Reposts: 2');
    });

    it('uses default count of 10', async () => {
      const handler = registeredTools.find(t => t.name === 'read_timeline').handler;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });
  });

  describe('read_replies handler', () => {
    it('returns formatted notifications', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const handler = registeredTools.find(t => t.name === 'read_replies').handler;
      const result = await handler({ limit: 25, include_read: false });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.count).toBe(1);
      expect(data.formatted).toContain('friend.bsky.social');
      expect(data.formatted).toContain('Great post!');
    });

    it('includes read notifications when requested', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({ lastSeen: '2026-03-15T15:00:00Z' }));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const handler = registeredTools.find(t => t.name === 'read_replies').handler;
      const result = await handler({ limit: 25, include_read: true });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });

    it('filters only new notifications by default', async () => {
      // Set a last_seen that's after the notification time (2026-03-15T14:00:00Z)
      fs.readFile.mockResolvedValue(JSON.stringify({ lastSeen: '2026-03-16T00:00:00Z' }));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const handler = registeredTools.find(t => t.name === 'read_replies').handler;
      const result = await handler({ limit: 25, include_read: false });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.count).toBe(0);
      expect(data.message).toContain('No new replies');
    });

    it('saves last seen timestamp', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const handler = registeredTools.find(t => t.name === 'read_replies').handler;
      await handler({ limit: 25, include_read: false });

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('last_seen.json'),
        expect.stringContaining('2026-03-15T14:00:00Z')
      );
    });
  });

  describe('edge cases', () => {
    it('clamps timeline count to max 50', async () => {
      const handler = registeredTools.find(t => t.name === 'read_timeline').handler;
      const result = await handler({ count: 999 });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });

    it('clamps timeline count to min 1', async () => {
      const handler = registeredTools.find(t => t.name === 'read_timeline').handler;
      const result = await handler({ count: -5 });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });

    it('clamps reply limit to valid range', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      fs.mkdir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const handler = registeredTools.find(t => t.name === 'read_replies').handler;
      const result = await handler({ limit: 999, include_read: true });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
    });

    it('handles exactly 300 char post', async () => {
      const handler = registeredTools.find(t => t.name === 'bluesky_post').handler;
      const result = await handler({ text: 'X'.repeat(300) });
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe('success');
      expect(data.charCount).toBe(300);
    });
  });
});
