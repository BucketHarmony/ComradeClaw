#!/usr/bin/env node
/**
 * test_reddit_comment.js — Reddit OAuth flow validator (dry-run)
 *
 * Tests the full Reddit OAuth flow WITHOUT posting anything:
 *   1. Checks required env vars are present
 *   2. Fetches a ROPC access token from Reddit
 *   3. Validates the token by calling /api/v1/me
 *   4. Optionally verifies a target post is reachable
 *
 * Usage:
 *   node workspace/scripts/test_reddit_comment.js
 *   node workspace/scripts/test_reddit_comment.js t3_<post_id>
 *
 * Set in .env before running:
 *   REDDIT_CLIENT_ID=...
 *   REDDIT_CLIENT_SECRET=...
 *   REDDIT_USERNAME=...
 *   REDDIT_PASSWORD=...
 *
 * This script never posts. It is safe to run at any time.
 */

import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..', '..');

// Load .env manually (dotenv not guaranteed to be installed in script context)
async function loadEnv() {
  try {
    const envPath = path.join(ROOT, '.env');
    const raw = await readFile(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    }
    return true;
  } catch {
    return false; // .env may not exist; env vars may be set externally
  }
}

function check(label, value) {
  if (value) {
    console.log(`  ✓ ${label}: set (${value.slice(0, 4)}...)`);
    return true;
  } else {
    console.log(`  ✗ ${label}: MISSING`);
    return false;
  }
}

async function fetchOAuthToken(clientId, clientSecret, username, password) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
  });

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ComradeClaw/1.0 (by /u/Calm_Delivery6725)',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '(no body)');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`OAuth error: ${data.error}`);
  return data;
}

async function validateToken(token) {
  const res = await fetch('https://oauth.reddit.com/api/v1/me', {
    headers: {
      'Authorization': `bearer ${token}`,
      'User-Agent': 'ComradeClaw/1.0 (by /u/Calm_Delivery6725)',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`/api/v1/me returned HTTP ${res.status}`);
  return res.json();
}

async function verifyPostReachable(token, fullname) {
  // fullname e.g. t3_abc123
  const id = fullname.replace(/^t3_/, '');
  const res = await fetch(`https://oauth.reddit.com/api/info?id=${fullname}`, {
    headers: {
      'Authorization': `bearer ${token}`,
      'User-Agent': 'ComradeClaw/1.0 (by /u/Calm_Delivery6725)',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`/api/info returned HTTP ${res.status}`);
  const data = await res.json();
  const posts = data?.data?.children || [];
  if (posts.length === 0) throw new Error(`Post ${fullname} not found or inaccessible`);
  return posts[0].data;
}

async function main() {
  console.log('\n=== Reddit OAuth Validator (dry-run) ===\n');

  await loadEnv();

  // Step 1: Check required env vars
  console.log('Step 1: Required credentials');
  const clientId     = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  const username     = process.env.REDDIT_USERNAME;
  const password     = process.env.REDDIT_PASSWORD;

  const allSet = [
    check('REDDIT_CLIENT_ID', clientId),
    check('REDDIT_CLIENT_SECRET', clientSecret),
    check('REDDIT_USERNAME', username),
    check('REDDIT_PASSWORD', password),
  ].every(Boolean);

  if (!allSet) {
    console.log('\n✗ Credential check failed. Set missing vars in .env and retry.\n');
    process.exit(1);
  }

  // Step 2: Fetch OAuth token
  console.log('\nStep 2: Fetching OAuth token from Reddit');
  let tokenData;
  try {
    tokenData = await fetchOAuthToken(clientId, clientSecret, username, password);
    console.log(`  ✓ Token received (expires_in: ${tokenData.expires_in}s)`);
    console.log(`  ✓ Scope: ${tokenData.scope}`);
  } catch (err) {
    console.log(`  ✗ Token fetch failed: ${err.message}`);
    console.log('\n  Common causes:');
    console.log('    - Wrong client ID/secret (must be "script" app, not "web app")');
    console.log('    - Wrong username/password');
    console.log('    - App not approved for ROPC on this account');
    process.exit(1);
  }

  // Step 3: Validate token with /me
  console.log('\nStep 3: Validating token via /api/v1/me');
  let me;
  try {
    me = await validateToken(tokenData.access_token);
    console.log(`  ✓ Authenticated as: u/${me.name}`);
    console.log(`  ✓ Account created: ${new Date(me.created_utc * 1000).toISOString().slice(0, 10)}`);
    console.log(`  ✓ Comment karma: ${me.comment_karma}`);
    if (me.is_suspended) {
      console.log('  ⚠ Account is suspended — commenting will fail');
    }
  } catch (err) {
    console.log(`  ✗ Token validation failed: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Optionally verify a target post
  const targetFullname = process.argv[2];
  if (targetFullname) {
    console.log(`\nStep 4: Verifying target post ${targetFullname}`);
    try {
      const post = await verifyPostReachable(tokenData.access_token, targetFullname);
      console.log(`  ✓ Post found: "${post.title.slice(0, 60)}"`);
      console.log(`  ✓ Subreddit: r/${post.subreddit}`);
      console.log(`  ✓ Author: u/${post.author}`);
      console.log(`  ✓ Permalink: https://old.reddit.com${post.permalink}`);
      if (post.locked) console.log('  ⚠ Post is locked — commenting will fail');
      if (post.archived) console.log('  ⚠ Post is archived — commenting may fail');
    } catch (err) {
      console.log(`  ✗ Post verification failed: ${err.message}`);
    }
  } else {
    console.log('\nStep 4: Skipped (no post fullname provided)');
    console.log('  Tip: run with a post fullname to verify a specific thread:');
    console.log('    node workspace/scripts/test_reddit_comment.js t3_<id>');
  }

  console.log('\n=== All checks passed. OAuth flow is ready for live use. ===\n');
  console.log('Next step: use reddit_post_comment tool from Claude with a real thread.');
  console.log('The tool lives in src/mcp/reddit-server.js — same getRedditOAuthToken() logic.\n');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
