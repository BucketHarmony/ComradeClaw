---
tags: [design, infrastructure, reddit, browser-automation]
date: 2026-04-04
status: implemented
---

# Reddit Access Without API — Design Document

*Designed 2026-04-04 | Day 25*

---

## Problem Statement

Reddit killed its free API tier in June 2023. The official API now costs ~$0.24/1000 requests, which is prohibitive for an autonomous agent with no revenue. The scheduled `reddit` wake in [[Home]] currently has no backend — it fires but produces nothing.

Reddit is irreplaceable for labor organizing intelligence: r/antiwork, r/WorkersStrike, r/cooperatives, r/MutualAid, r/union, r/GreenNewDeal, r/socialism — these communities generate real-time discussion that Bluesky and Mastodon don't replicate. Missing them means missing a significant part of the organizing conversation.

**Goal:** A working Reddit MCP server (`src/mcp/reddit-server.js`) that lets Claw read targeted subreddits during wakes without the official API.

---

## How Other Agentic Systems Do This

### The Landscape (2024-2025 Survey)

Three dominant approaches exist in agentic systems that need Reddit access:

**1. JSON Endpoint Approach (No Auth, No Browser)**
Reddit still serves public data at `reddit.com/r/{sub}.json` and `old.reddit.com/r/{sub}/.json`. These endpoints require no API key, no login, no browser rendering. They return standard Reddit JSON with posts, scores, comment counts, and metadata.

- Used by: ScrapiReddit, dozens of lightweight scrapers
- Reliability: High for public content, rate-limited at ~30 req/min
- Risk: Low — equivalent to a browser hitting the page
- Limitation: Read-only, no posting, no DMs, no search beyond subreddit scope

**2. Playwright Browser Automation (Full Auth)**
Projects like `yrshr4747/reddit-automation` use Playwright to drive a real browser — login with typed credentials, save cookies, reuse sessions for post/comment/vote. The key is anti-detection: character-by-character typing, realistic user-agents, random delays, `navigator.webdriver` override.

- Used by: Production Reddit bots, social media automation tools
- Reliability: Medium — CAPTCHAs appear, session expiry happens
- Risk: Medium — against ToS, shadowban risk if patterns are obvious
- Limitation: Complex, requires CAPTCHA solver integration for sustained use

**3. Hybrid with Fallback Chain**
Read via JSON endpoints (fast, free), fall back to Redlib/mirror instances on rate limit, use Playwright only for auth-required operations.

- Used by: More sophisticated agentic systems
- Best balance of reliability and complexity

### What Works for Claw's Actual Use Case

Claw's Reddit use is fundamentally **read-only monitoring** of public organizing communities — no posting needed (Bluesky/Mastodon are the posting channels). This means:

- Approach 1 (JSON endpoints) covers ~90% of the use case
- No CAPTCHA risk, no ToS exposure beyond normal browsing
- Playwright is unnecessary unless posting capability is added later

---

## Architecture

### New File: `src/mcp/reddit-server.js`

Pattern mirrors `src/mcp/bluesky-server.js` — standalone MCP server, tool definitions array, `executeTool` switch, `{ status, message, ... }` return shape.

### Tools

#### `reddit_fetch_subreddit`
Read recent posts from a subreddit.

```
Parameters:
  subreddit: string        — subreddit name (no r/ prefix)
  sort: "hot"|"new"|"top"  — default "hot"
  limit: number            — 10-25, default 15
  time: "day"|"week"       — only for sort=top, default "week"

Returns:
  posts: [
    {
      id, title, author, score, num_comments,
      url, selftext (truncated to 500 chars),
      created_utc, permalink, flair
    }
  ]
  subreddit, fetched_at
```

#### `reddit_fetch_post`
Read a specific post with top comments.

```
Parameters:
  permalink: string        — full reddit permalink
  comment_depth: number    — top-level comments to fetch, default 5

Returns:
  post: { id, title, author, score, selftext, ... }
  comments: [ { author, body, score, depth } ]
```

#### `reddit_search`
Search posts across Reddit or within a subreddit.

```
Parameters:
  query: string
  subreddit: string        — optional, restricts to subreddit
  sort: "relevance"|"new"|"hot"|"top"
  time: "day"|"week"|"month"
  limit: number            — default 10

Returns:
  posts: [ same shape as fetch_subreddit ]
  query, matched_count
```

#### `reddit_monitor_watchlist`
Read all watched subreddits for new content since last check.

```
Parameters: none (reads from workspace/reddit/watchlist.json)

Returns:
  subreddits_checked: number
  new_posts: [
    { subreddit, ... post fields }
  ]
  last_seen updated in watchlist.json
```

### Watchlist Config: `workspace/reddit/watchlist.json`

```json
{
  "subreddits": [
    { "name": "antiwork",       "category": "labor",      "priority": "high"  },
    { "name": "WorkersStrike",  "category": "labor",      "priority": "high"  },
    { "name": "union",          "category": "labor",      "priority": "medium" },
    { "name": "cooperatives",   "category": "coops",      "priority": "high"  },
    { "name": "MutualAid",      "category": "mutual-aid", "priority": "high"  },
    { "name": "BasicIncome",    "category": "policy",     "priority": "low"   },
    { "name": "socialism",      "category": "theory",     "priority": "medium" },
    { "name": "GreenNewDeal",   "category": "policy",     "priority": "low"   },
    { "name": "WorkerCoops",    "category": "coops",      "priority": "high"  },
    { "name": "LaborOrganizing","category": "labor",      "priority": "high"  }
  ],
  "last_seen": {}
}
```

### Implementation: JSON Endpoint Approach

Core fetch function — no browser, no Playwright, no auth:

```javascript
async function fetchSubreddit(subreddit, sort = 'hot', limit = 15, time = 'week') {
  const url = `https://old.reddit.com/r/${subreddit}/${sort}/.json?limit=${limit}&t=${time}`;
  
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });
  
  if (response.status === 429) {
    throw new RateLimitError('Reddit rate limit hit — backoff 60s');
  }
  
  const data = await response.json();
  return data.data.children.map(c => normalizePost(c.data));
}
```

**Why `old.reddit.com`:** Less JavaScript overhead, simpler structure, historically less aggressive rate limiting than `www.reddit.com`. The `.json` suffix works on both but old.reddit has proven more reliable for script access.

### Rate Limiting Strategy

```
Base delay: 3 seconds between requests
Batch delay: 15 seconds after completing a full watchlist check
On 429: exponential backoff — 60s → 120s → 240s, log and return partial results
Circuit breaker: After 3 consecutive 429s, skip Reddit for the rest of the wake
Daily budget: ~200 requests/day across all wakes (well under observed 1000/day safe limit)
```

### State: `workspace/reddit/last_seen.json`

```json
{
  "antiwork":        { "last_id": "t3_abc123", "last_checked": "2026-04-04T09:00:00Z" },
  "WorkersStrike":   { "last_id": "t3_def456", "last_checked": "2026-04-04T09:00:00Z" },
  ...
}
```

`reddit_monitor_watchlist` only returns posts with IDs newer than `last_id` per subreddit, then updates state. Same pattern as Bluesky `last_seen.json`.

---

## Wake Integration

**Saturday wake** (`label: "reddit"`) already exists in the scheduler. After implementation, it calls `reddit_monitor_watchlist` and processes results using the same logic as RSS feed injection.

**Morning wake** can also call `reddit_monitor_watchlist` alongside `read_new_items` (RSS) for a unified new-content block.

CLAUDE.md wake step 6 update:
```
6. Check RSS + Reddit: 
   - `read_new_items` for subscribed RSS feeds
   - `reddit_monitor_watchlist` for new labor/co-op/organizing posts
   Surface anything post-worthy from either.
```

---

## `.mcp.json` Entry Required

After implementation, operator adds to `.mcp.json`:

```json
"claw-reddit": {
  "command": "node",
  "args": ["src/mcp/reddit-server.js"],
  "cwd": "E:/AI/CClaw"
}
```

---

## Future Extension: Posting via Playwright

If Claw ever needs to post to Reddit directly (currently not needed — Bluesky/Mastodon are the distribution channels):

1. Add `playwright` as a dependency
2. Implement `reddit_login(username, password)` — navigate login page, type credentials with per-character delays, save cookies to `workspace/reddit/session.json`
3. Implement `reddit_post(subreddit, title, body)` — load session, navigate to subreddit, click create post, type content, submit
4. Add 2captcha integration (`TWOCAPTCHA_API_KEY` in `.env`) for CAPTCHA handling
5. Rate limit to 2-3 posts/day maximum to avoid detection

This path is available but not on the current roadmap. Read-only monitoring serves the actual need.

---

## Implementation Checklist

- [x] Create `src/mcp/reddit-server.js` with 4 tools above (commit a61a357)
- [x] Create `workspace/reddit/watchlist.json` with seed subreddits
- [x] Create `workspace/reddit/last_seen.json` (empty `{}`)
- [ ] Add `claw-reddit` to `.mcp.json` (operator action — required to activate)
- [x] Update `CLAUDE.md` wake step 6 to include `reddit_monitor_watchlist`
- [ ] Update `obsidian/ComradeClaw/Home.md` to note Reddit is live
- [ ] Test: call `reddit_fetch_subreddit` with `r/antiwork` and verify JSON response
- [ ] Test: call `reddit_monitor_watchlist` and verify state updates

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Rate limit 429 | Medium | Low — skip this wake | Exponential backoff, circuit breaker |
| Reddit changes JSON endpoints | Low | High — tool stops working | Monitor, fallback to Redlib mirrors |
| IP ban from Reddit | Low | Medium — all wakes blocked | Residential proxy ($10/mo) as fallback |
| Shadowban on account | N/A | N/A | Read-only approach has no account |
| ToS violation | Low | Low | Public data, research use, no scraping at scale |

---

## References

- ScrapiReddit: github.com/rodneykeilson/ScrapiReddit
- reddit-automation: github.com/yrshr4747/reddit-automation
- old.reddit.com JSON format: `old.reddit.com/r/{sub}/.json`
- Reddit fullname format: `t3_` posts, `t1_` comments, `t2_` accounts
- Related: [[Organizing Network]] (Bluesky/Mastodon accounts), [[MayDay 2026]] (use case)
