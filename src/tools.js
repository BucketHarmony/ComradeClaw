/**
 * Tools Module (v2.0 — utilities only)
 *
 * Most tool implementations have been replaced by Claude Code built-ins
 * and the Bluesky MCP server. This file retains only utility functions
 * needed by the Node.js relay (scheduler, commands).
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE_PATH = process.env.WORKSPACE_PATH || path.join(__dirname, '..', 'workspace');
const PLANS_PATH = path.join(WORKSPACE_PATH, 'plans');

// Day 1 start date - March 11, 2026
const DAY_ONE = new Date('2026-03-11T00:00:00');

/**
 * Get current day number based on calendar days since start
 */
export async function getDayNumber() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffTime = startOfToday - DAY_ONE;
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  return diffDays + 1;
}

/**
 * Read a plan file
 */
export async function readPlan(filepath) {
  const content = await fs.readFile(filepath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Get the latest plan file path
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

export default { getDayNumber, readPlan, getLatestPlanPath };
