import { describe, it, expect } from 'vitest';
import { formatPlan } from '../src/plan-format.js';

describe('plan-format.js', () => {
  describe('formatPlan', () => {
    it('formats a complete plan with done tasks', () => {
      const plan = {
        wake: 'morning',
        day: 5,
        time: '09:00',
        status: 'complete',
        tasks: [
          { type: 'search', status: 'done', reason: 'find material', summary: 'Found 3 results', toolCalls: ['web_search'] },
          { type: 'journal', status: 'done', reason: 'write entry', summary: 'Wrote Day 5', toolCalls: ['journal_write', 'read_memory'] },
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('**Morning Wake — Day 5 — 09:00**');
      expect(result).toContain('Status: complete');
      expect(result).toContain('[done] **search**: Found 3 results');
      expect(result).toContain('(called: web_search)');
      expect(result).toContain('[done] **journal**: Wrote Day 5');
      expect(result).toContain('(called: journal_write, read_memory)');
    });

    it('formats pending tasks with reason', () => {
      const plan = {
        wake: 'noon',
        day: 3,
        time: '12:00',
        status: 'in_progress',
        tasks: [
          { type: 'search', status: 'pending', reason: 'look for co-ops' }
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('[pending] **search**: look for co-ops');
    });

    it('formats failed tasks', () => {
      const plan = {
        wake: 'evening',
        day: 7,
        time: '18:00',
        status: 'partial',
        tasks: [
          { type: 'distribute', status: 'failed', reason: 'post to bluesky', summary: 'Auth error' }
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('[failed] **distribute**: Auth error');
    });

    it('formats skipped tasks', () => {
      const plan = {
        wake: 'night',
        day: 1,
        time: '23:00',
        status: 'complete',
        tasks: [
          { type: 'nothing', status: 'skipped', reason: 'empty wake', summary: 'No work needed' }
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('[skipped] **nothing**: No work needed');
    });

    it('formats in_progress tasks', () => {
      const plan = {
        wake: 'afternoon',
        day: 2,
        time: '15:00',
        status: 'in_progress',
        tasks: [
          { type: 'memory', status: 'in_progress', reason: 'update threads' }
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('[in_progress] **memory**: update threads');
    });

    it('shows "no tools called" for done tasks with empty toolCalls', () => {
      const plan = {
        wake: 'morning',
        day: 1,
        time: '09:00',
        status: 'complete',
        tasks: [
          { type: 'check_inbox', status: 'done', reason: 'check', summary: 'Nothing new', toolCalls: [] }
        ]
      };

      const result = formatPlan(plan);
      expect(result).toContain('(no tools called)');
    });

    it('capitalizes wake label', () => {
      const plan = { wake: 'afternoon', day: 1, time: '15:00', status: 'complete', tasks: [] };
      expect(formatPlan(plan)).toContain('**Afternoon Wake');
    });
  });
});
