import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// Mock fs before importing module
vi.mock('fs/promises');

const { getDayNumber, readPlan, getLatestPlanPath } = await import('../src/tools.js');

describe('tools.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getDayNumber', () => {
    it('returns 1 on March 11, 2026', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T12:00:00'));
      expect(await getDayNumber()).toBe(1);
      vi.useRealTimers();
    });

    it('returns 2 on March 12, 2026', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:00:00'));
      expect(await getDayNumber()).toBe(2);
      vi.useRealTimers();
    });

    it('returns 20 on March 30, 2026', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-30T12:00:00'));
      expect(await getDayNumber()).toBe(20);
      vi.useRealTimers();
    });

    it('handles early morning (still same day)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T01:00:00'));
      expect(await getDayNumber()).toBe(1);
      vi.useRealTimers();
    });

    it('handles late night (still same day)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T23:59:59'));
      expect(await getDayNumber()).toBe(1);
      vi.useRealTimers();
    });
  });

  describe('readPlan', () => {
    it('parses a valid plan file', async () => {
      const plan = { wake: 'morning', day: 5, tasks: [] };
      fs.readFile.mockResolvedValue(JSON.stringify(plan));

      const result = await readPlan('/some/path.json');
      expect(result).toEqual(plan);
      expect(fs.readFile).toHaveBeenCalledWith('/some/path.json', 'utf-8');
    });

    it('throws on invalid JSON', async () => {
      fs.readFile.mockResolvedValue('not json');
      await expect(readPlan('/bad.json')).rejects.toThrow();
    });

    it('throws on missing file', async () => {
      fs.readFile.mockRejectedValue(new Error('ENOENT'));
      await expect(readPlan('/missing.json')).rejects.toThrow('ENOENT');
    });
  });

  describe('getLatestPlanPath', () => {
    it('returns the most recent plan file', async () => {
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([
        '2026-03-10_morning.json',
        '2026-03-11_noon.json',
        '2026-03-11_morning.json',
      ]);

      const result = await getLatestPlanPath();
      expect(result).toContain('2026-03-11_noon.json');
    });

    it('returns null when no plans exist', async () => {
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue([]);

      expect(await getLatestPlanPath()).toBeNull();
    });

    it('returns null on readdir error', async () => {
      fs.mkdir.mockRejectedValue(new Error('fail'));

      expect(await getLatestPlanPath()).toBeNull();
    });

    it('ignores non-json files', async () => {
      fs.mkdir.mockResolvedValue(undefined);
      fs.readdir.mockResolvedValue(['notes.md', 'readme.txt']);

      expect(await getLatestPlanPath()).toBeNull();
    });
  });
});
