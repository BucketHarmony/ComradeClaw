import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process and fs before importing
vi.mock('child_process');
vi.mock('fs/promises');

const childProcess = await import('child_process');
const fs = (await import('fs/promises')).default;

// Mock getDayNumber
vi.mock('../src/tools.js', () => ({
  getDayNumber: vi.fn().mockResolvedValue(5),
  default: { getDayNumber: vi.fn().mockResolvedValue(5) }
}));

const { invokeClaude, chat, executeWake, clearChatSession } = await import('../src/dispatcher.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockProcess(stdout = '', stderr = '', exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  childProcess.spawn.mockReturnValue(proc);

  // Emit data async
  setTimeout(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

const validClaudeOutput = JSON.stringify([
  { type: 'system', subtype: 'init' },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Hello from Claw' },
        { type: 'tool_use', name: 'WebSearch' },
        { type: 'tool_use', name: 'Read' },
      ]
    }
  },
  {
    type: 'result',
    result: 'Hello from Claw',
    session_id: 'abc-123',
    total_cost_usd: 0.0042
  }
]);

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('dispatcher.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('invokeClaude', () => {
    it('spawns claude with correct base args', async () => {
      createMockProcess(validClaudeOutput);

      await invokeClaude('Hello');

      expect(childProcess.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['-p', '--output-format', 'json', '--model', 'sonnet', '--dangerously-skip-permissions', '--no-session-persistence', 'Hello']),
        expect.objectContaining({ shell: true })
      );
    });

    it('parses JSON output correctly', async () => {
      createMockProcess(validClaudeOutput);

      const result = await invokeClaude('Hello');
      expect(result.text).toBe('Hello from Claw');
      expect(result.sessionId).toBe('abc-123');
      expect(result.cost).toBe(0.0042);
      expect(result.toolsUsed).toEqual(['WebSearch', 'Read']);
    });

    it('adds --append-system-prompt when provided', async () => {
      createMockProcess(validClaudeOutput);

      await invokeClaude('Hi', { appendSystemPrompt: 'You are Claw' });

      expect(childProcess.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--append-system-prompt', 'You are Claw']),
        expect.anything()
      );
    });

    it('always includes --no-session-persistence (stateless)', async () => {
      createMockProcess(validClaudeOutput);

      await invokeClaude('Hi');

      const args = childProcess.spawn.mock.calls[0][1];
      expect(args).toContain('--no-session-persistence');
    });

    it('adds --allowed-tools when provided', async () => {
      createMockProcess(validClaudeOutput);

      await invokeClaude('Hi', { allowedTools: ['Read', 'Write'] });

      const args = childProcess.spawn.mock.calls[0][1];
      expect(args).toContain('--allowed-tools');
      expect(args).toContain('Read');
      expect(args).toContain('Write');
    });

    it('uses custom model', async () => {
      createMockProcess(validClaudeOutput);

      await invokeClaude('Hi', { model: 'opus' });

      const args = childProcess.spawn.mock.calls[0][1];
      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('falls back to raw stdout on JSON parse failure', async () => {
      createMockProcess('Some plain text response');

      const result = await invokeClaude('Hi');
      expect(result.text).toBe('Some plain text response');
      expect(result.sessionId).toBeNull();
      expect(result.toolsUsed).toEqual([]);
    });

    it('rejects on empty output', async () => {
      createMockProcess('', 'some error', 1);

      await expect(invokeClaude('Hi')).rejects.toThrow('Claude CLI failed');
    });

    it('rejects on spawn error', async () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      childProcess.spawn.mockReturnValue(proc);

      setTimeout(() => {
        proc.emit('error', new Error('ENOENT'));
      }, 10);

      await expect(invokeClaude('Hi')).rejects.toThrow('Failed to spawn claude');
    });

    it('filters deprecation warnings from stderr', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createMockProcess(validClaudeOutput, '(node:123) [DEP0040] DeprecationWarning: punycode\nUse --trace-deprecation');

      await invokeClaude('Hi');
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('logs real stderr errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createMockProcess(validClaudeOutput, 'Real error occurred');

      await invokeClaude('Hi');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Real error occurred'));
      consoleSpy.mockRestore();
    });

    it('handles output with no tool_use blocks', async () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'No tools' }] } },
        { type: 'result', result: 'No tools used', session_id: 'x', total_cost_usd: 0.001 }
      ]);
      createMockProcess(output);

      const result = await invokeClaude('Hi');
      expect(result.toolsUsed).toEqual([]);
    });

    it('handles output with no result event', async () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
      ]);
      createMockProcess(output);

      const result = await invokeClaude('Hi');
      expect(result.text).toBe('');
      expect(result.sessionId).toBeNull();
    });
  });

  describe('chat', () => {
    it('invokes claude with chat context', async () => {
      createMockProcess(validClaudeOutput);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await chat('Hello operator');
      expect(result).toBe('Hello from Claw');
      expect(childProcess.spawn).toHaveBeenCalled();

      console.log.mockRestore();
    });

    it('uses stateless invocation (no session persistence)', async () => {
      createMockProcess(validClaudeOutput);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      await chat('Continue conversation');

      const args = childProcess.spawn.mock.calls[0][1];
      expect(args).toContain('--no-session-persistence');
      expect(args).not.toContain('--session-id');

      console.log.mockRestore();
    });

    it('includes day number in context', async () => {
      createMockProcess(validClaudeOutput);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      await chat('Test');

      const args = childProcess.spawn.mock.calls[0][1];
      const sysPromptIdx = args.indexOf('--append-system-prompt');
      const sysPrompt = args[sysPromptIdx + 1];
      expect(sysPrompt).toContain('Day 5');

      console.log.mockRestore();
    });
  });

  describe('executeWake', () => {
    it('invokes claude with wake context', async () => {
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([]);
      createMockProcess(validClaudeOutput);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('morning', '09:00');
      expect(result.label).toBe('morning');
      expect(result.time).toBe('09:00');
      expect(result.tools_used).toEqual(['WebSearch', 'Read']);

      console.log.mockRestore();
    });

    it('detects bluesky posting', async () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claw_social__bluesky_post' }] } },
        { type: 'result', result: 'Posted', session_id: 'x', total_cost_usd: 0.01 }
      ]);
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([]);
      createMockProcess(output);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('evening', '18:00');
      expect(result.bluesky_posted).toBe(true);

      console.log.mockRestore();
    });

    it('marks empty wake when no tools used', async () => {
      const output = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'result', result: 'Nothing to do', session_id: 'x', total_cost_usd: 0.001 }
      ]);
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([]);
      createMockProcess(output);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('night', '23:00');
      expect(result.empty).toBe(true);

      console.log.mockRestore();
    });

    it('includes prior plans in context', async () => {
      fs.mkdir.mockResolvedValue(undefined);
      // Return today's date-prefixed file
      const today = new Date().toISOString().split('T')[0];
      fs.readdir.mockResolvedValue([`${today}_morning.json`]);
      fs.readFile.mockResolvedValue(JSON.stringify({
        wake: 'morning', time: '09:00', status: 'complete',
        tasks: [{ type: 'search', status: 'done', summary: 'Found 3 co-ops', reason: 'look' }]
      }));
      createMockProcess(validClaudeOutput);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeWake('evening', '18:00');

      const args = childProcess.spawn.mock.calls[0][1];
      const sysPromptIdx = args.indexOf('--append-system-prompt');
      const sysPrompt = args[sysPromptIdx + 1];
      expect(sysPrompt).toContain('morning');
      expect(sysPrompt).toContain('Found 3 co-ops');

      console.log.mockRestore();
    });

    it('truncates long summaries', async () => {
      const longText = 'A'.repeat(300);
      const output = JSON.stringify([
        { type: 'system', subtype: 'init' },
        { type: 'result', result: longText, session_id: 'x', total_cost_usd: 0.01 }
      ]);
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([]);
      createMockProcess(output);

      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('noon', '12:00');
      expect(result.summary.length).toBe(200);
      expect(result.summary.endsWith('...')).toBe(true);

      console.log.mockRestore();
    });
  });

  describe('clearChatSession', () => {
    it('deletes session file', async () => {
      fs.unlink.mockResolvedValue(undefined);
      await clearChatSession();
      expect(fs.unlink).toHaveBeenCalledWith(expect.stringContaining('chat-session.json'));
    });

    it('does not throw if file missing', async () => {
      fs.unlink.mockRejectedValue(new Error('ENOENT'));
      await expect(clearChatSession()).resolves.toBeUndefined();
    });
  });
});
