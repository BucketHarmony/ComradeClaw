import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';

vi.mock('fs/promises');
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
  schedule: vi.fn()
}));

vi.mock('../src/tools.js', () => ({
  getDayNumber: vi.fn().mockResolvedValue(5),
  default: { getDayNumber: vi.fn().mockResolvedValue(5) }
}));

vi.mock('../src/dispatcher.js', () => ({
  executeWake: vi.fn().mockResolvedValue({
    time: '09:00', label: 'morning', tools_used: ['WebSearch'],
    journal_written: false, bluesky_posted: false, memory_updated: false,
    summary: 'Searched for material', empty: false
  }),
  default: {}
}));

vi.mock('../src/plan-format.js', () => ({
  formatPlan: vi.fn().mockReturnValue('formatted'),
  default: {}
}));

const {
  startScheduler, executeWake, triggerWake, setDiscordClient,
  setChatProcessing, getWakeSummary
} = await import('../src/scheduler.js');

const { executeWake: dispatchWake } = await import('../src/dispatcher.js');
const cron = (await import('node-cron')).default;

describe('scheduler.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('startScheduler', () => {
    it('schedules 5 wakes', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      startScheduler();
      expect(cron.schedule).toHaveBeenCalledTimes(5);
      console.log.mockRestore();
    });

    it('uses configured timezone', () => {
      process.env.TZ = 'America/Detroit';
      vi.spyOn(console, 'log').mockImplementation(() => {});
      startScheduler();

      expect(cron.schedule).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Function),
        expect.objectContaining({ timezone: 'America/Detroit' })
      );
      console.log.mockRestore();
    });
  });

  describe('executeWake', () => {
    it('dispatches to Claude Code and logs result', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('morning', '09:00');
      expect(dispatchWake).toHaveBeenCalledWith('morning', '09:00');
      expect(fs.writeFile).toHaveBeenCalled();
      expect(result.summary).toBe('Searched for material');

      console.log.mockRestore();
    });

    it('queues wake when chat is active', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      setChatProcessing(true);

      const result = await executeWake('noon', '12:00');
      expect(result).toBeUndefined(); // queued, not executed
      expect(dispatchWake).not.toHaveBeenCalled();

      console.log.mockRestore();
    });

    it('processes queued wake when chat finishes', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      setChatProcessing(true);
      await executeWake('noon', '12:00');
      expect(dispatchWake).not.toHaveBeenCalled();

      setChatProcessing(false); // should trigger queued wake
      // Give it a tick to process
      await new Promise(r => setTimeout(r, 50));
      expect(dispatchWake).toHaveBeenCalledWith('noon', '12:00');

      console.log.mockRestore();
    });

    it('handles wake failure gracefully', async () => {
      dispatchWake.mockRejectedValueOnce(new Error('API down'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeWake('afternoon', '15:00');
      expect(result.error).toBe(true);
      expect(result.summary).toContain('API down');
      expect(fs.writeFile).toHaveBeenCalled(); // still logged

      console.error.mockRestore();
      console.log.mockRestore();
    });

    it('notifies operator on success (no discord)', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeWake('evening', '18:00');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Would notify'));

      logSpy.mockRestore();
    });

    it('formats plan-based notification when planFile exists', async () => {
      const wakeResult = {
        time: '09:00', label: 'morning', tools_used: ['WebSearch'],
        journal_written: false, bluesky_posted: false, memory_updated: false,
        summary: 'Searched', empty: false,
        planFile: '/plans/test.json'
      };
      dispatchWake.mockResolvedValueOnce(wakeResult);
      fs.readFile.mockImplementation((path) => {
        if (path === '/plans/test.json' || String(path).includes('test.json')) {
          return Promise.resolve(JSON.stringify({
            wake: 'morning', day: 5, time: '09:00', status: 'complete', tasks: []
          }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeWake('morning', '09:00');
      // Plan file read + formatPlan called
      expect(fs.readFile).toHaveBeenCalled();

      console.log.mockRestore();
    });

    it('falls back to summary when planFile read fails', async () => {
      const wakeResult = {
        time: '09:00', label: 'morning', tools_used: [],
        journal_written: false, bluesky_posted: false, memory_updated: false,
        summary: 'Something happened', empty: false,
        planFile: '/plans/corrupt.json'
      };
      dispatchWake.mockResolvedValueOnce(wakeResult);
      fs.readFile.mockRejectedValue(new Error('ENOENT'));

      vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeWake('morning', '09:00');
      // Should not throw, uses summary fallback
      console.log.mockRestore();
    });

    it('notifies operator via Discord when connected', async () => {
      const mockUser = { send: vi.fn().mockResolvedValue(undefined) };
      const mockClient = { users: { fetch: vi.fn().mockResolvedValue(mockUser) } };
      setDiscordClient(mockClient, 'op-123');

      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeWake('morning', '09:00');
      expect(mockClient.users.fetch).toHaveBeenCalledWith('op-123');
      expect(mockUser.send).toHaveBeenCalled();

      setDiscordClient(null, null); // reset
      console.log.mockRestore();
    });
  });

  describe('triggerWake', () => {
    it('determines morning wake before noon', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T10:00:00'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake();
      expect(dispatchWake).toHaveBeenCalledWith('morning', '09:00');

      console.log.mockRestore();
    });

    it('determines noon wake 12-15', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T13:00:00'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake();
      expect(dispatchWake).toHaveBeenCalledWith('noon', '12:00');

      console.log.mockRestore();
    });

    it('determines afternoon wake 15-18', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T16:00:00'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake();
      expect(dispatchWake).toHaveBeenCalledWith('afternoon', '15:00');

      console.log.mockRestore();
    });

    it('determines evening wake 18-23', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T20:00:00'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake();
      expect(dispatchWake).toHaveBeenCalledWith('evening', '18:00');

      console.log.mockRestore();
    });

    it('determines night wake at 23+', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-15T23:30:00'));
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake();
      expect(dispatchWake).toHaveBeenCalledWith('night', '23:00');

      console.log.mockRestore();
    });

    it('uses explicit label when provided', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await triggerWake('noon');
      expect(dispatchWake).toHaveBeenCalledWith('noon', '12:00');

      console.log.mockRestore();
    });

    it('throws on unknown label', async () => {
      await expect(triggerWake('midnight')).rejects.toThrow('Unknown wake: midnight');
    });
  });

  describe('getWakeSummary', () => {
    it('returns no-wakes message when empty', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      const result = await getWakeSummary();
      expect(result).toBe('No wakes yet today.');
    });

    it('summarizes wakes with counts', async () => {
      fs.readFile.mockResolvedValue(JSON.stringify({
        day: 5, date: '2026-03-15',
        wakes: [
          { label: 'morning', time: '09:00', summary: 'Searched', empty: false, bluesky_posted: true },
          { label: 'noon', time: '12:00', summary: 'Nothing', empty: true, bluesky_posted: false },
        ]
      }));

      const result = await getWakeSummary();
      expect(result).toContain('Day 5');
      expect(result).toContain('2 total');
      expect(result).toContain('1 active');
      expect(result).toContain('1 empty');
      expect(result).toContain('**morning**');
      expect(result).toContain('**noon**');
    });
  });
});
