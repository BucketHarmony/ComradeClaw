import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies
vi.mock('../src/dispatcher.js', () => ({
  chat: vi.fn(),
  clearChatSession: vi.fn(),
}));

vi.mock('../src/tools.js', () => ({
  getDayNumber: vi.fn().mockResolvedValue(7),
  getLatestPlanPath: vi.fn(),
  readPlan: vi.fn(),
  default: {}
}));

vi.mock('../src/scheduler.js', () => ({
  triggerWake: vi.fn().mockResolvedValue({ summary: 'done' }),
  getWakeSummary: vi.fn(),
}));

vi.mock('../src/plan-format.js', () => ({
  formatPlan: vi.fn().mockReturnValue('formatted plan'),
}));

const { handleOperatorCommand } = await import('../src/commands.js');
const { chat, clearChatSession } = await import('../src/dispatcher.js');
const { getDayNumber, getLatestPlanPath, readPlan } = await import('../src/tools.js');
const { triggerWake, getWakeSummary } = await import('../src/scheduler.js');
const { formatPlan } = await import('../src/plan-format.js');

describe('commands.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('status command', () => {
    it('returns day number and wake summary', async () => {
      getWakeSummary.mockResolvedValue('No wakes yet today.');

      const result = await handleOperatorCommand('status', {});
      expect(result).toContain('Day 7');
      expect(result).toContain('No wakes yet today.');
    });

    it('is case-insensitive', async () => {
      getWakeSummary.mockResolvedValue('summary');
      const result = await handleOperatorCommand('Status', {});
      expect(result).toContain('Day 7');
    });
  });

  describe('clear command', () => {
    it('clears session and returns confirmation', async () => {
      clearChatSession.mockResolvedValue(undefined);

      const result = await handleOperatorCommand('clear', {});
      expect(result).toBe('Conversation cleared.');
      expect(clearChatSession).toHaveBeenCalled();
    });
  });

  describe('wake command', () => {
    it('triggers current wake with no label', async () => {
      const result = await handleOperatorCommand('wake', {});
      expect(result).toContain('Triggering');
      expect(triggerWake).toHaveBeenCalledWith(null);
    });

    it('triggers specific wake label', async () => {
      const result = await handleOperatorCommand('wake morning', {});
      expect(result).toContain('Triggering morning wake');
      expect(triggerWake).toHaveBeenCalledWith('morning');
    });

    it('rejects invalid wake label', async () => {
      const result = await handleOperatorCommand('wake midnight', {});
      expect(result).toContain('Unknown wake: midnight');
    });

    it('handles triggerWake rejection gracefully', async () => {
      triggerWake.mockRejectedValueOnce(new Error('wake failed'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await handleOperatorCommand('wake morning', {});
      expect(result).toContain('Triggering morning');

      // Let the promise rejection settle
      await new Promise(r => setTimeout(r, 50));
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('wake failed'));
      console.error.mockRestore();
    });

    it('accepts all valid wake labels', async () => {
      for (const label of ['morning', 'noon', 'afternoon', 'evening', 'night']) {
        vi.clearAllMocks();
        const result = await handleOperatorCommand(`wake ${label}`, {});
        expect(result).toContain(`Triggering ${label} wake`);
      }
    });
  });

  describe('wakes command', () => {
    it('returns wake summary', async () => {
      getWakeSummary.mockResolvedValue('2 wakes today');

      const result = await handleOperatorCommand('wakes', {});
      expect(result).toBe('2 wakes today');
    });
  });

  describe('plan command', () => {
    it('returns formatted plan', async () => {
      getLatestPlanPath.mockResolvedValue('/path/to/plan.json');
      readPlan.mockResolvedValue({ wake: 'morning', tasks: [] });

      const result = await handleOperatorCommand('plan', {});
      expect(result).toBe('formatted plan');
      expect(formatPlan).toHaveBeenCalled();
    });

    it('returns message when no plans exist', async () => {
      getLatestPlanPath.mockResolvedValue(null);

      const result = await handleOperatorCommand('plan', {});
      expect(result).toBe('No wake plans yet.');
    });

    it('handles plan read errors', async () => {
      getLatestPlanPath.mockResolvedValue('/path.json');
      readPlan.mockRejectedValue(new Error('corrupt file'));

      const result = await handleOperatorCommand('plan', {});
      expect(result).toContain('Error reading plan');
    });
  });

  describe('help command', () => {
    it('returns help text', async () => {
      const result = await handleOperatorCommand('help', {});
      expect(result).toContain('status');
      expect(result).toContain('clear');
      expect(result).toContain('wake');
      expect(result).toContain('wakes');
      expect(result).toContain('plan');
      expect(result).toContain('help');
      expect(result).toContain('Claude Code');
    });
  });

  describe('chat fallthrough', () => {
    it('passes non-command messages to chat', async () => {
      chat.mockResolvedValue('Hello from Claw');

      const result = await handleOperatorCommand('Tell me about co-ops', {});
      expect(result).toBe('Hello from Claw');
      expect(chat).toHaveBeenCalledWith('Tell me about co-ops');
    });

    it('handles chat errors', async () => {
      chat.mockRejectedValue(new Error('API timeout'));

      vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await handleOperatorCommand('Hi there', {});
      expect(result).toContain('Error: API timeout');
      console.error.mockRestore();
    });

    it('trims whitespace from input', async () => {
      chat.mockResolvedValue('response');

      await handleOperatorCommand('  hello  ', {});
      expect(chat).toHaveBeenCalledWith('hello');
    });
  });
});
