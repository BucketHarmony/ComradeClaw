/**
 * seed_scrape skill
 *
 * Fetches RSS feeds from FALGSC-aligned sources, scores candidates,
 * and returns the best seed or null.
 */

import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'ComradeClaw/1.0 (autonomous solidarity bot)'
  }
});

// Feed configuration
const FEEDS = {
  cooperative: [
    { name: 'USFWC', url: 'https://www.usworker.coop/feed/' },
    { name: 'Democracy at Work', url: 'https://www.democracyatwork.info/feed' },
  ],
  mutual_aid: [
    { name: 'Mutual Aid Hub', url: 'https://www.mutualaidhub.org/feed/' },
    { name: 'Waging Nonviolence', url: 'https://wagingnonviolence.org/feed/' },
  ],
  labor: [
    { name: 'Labor Notes', url: 'https://labornotes.org/feed' },
    { name: 'In These Times', url: 'https://inthesetimes.com/feed' },
  ],
  theory: [
    { name: 'Jacobin', url: 'https://jacobin.com/feed' },
  ],
  local: [
    { name: 'Bridge Michigan', url: 'https://www.bridgemi.com/feed' },
    { name: 'Outlier Media', url: 'https://outliermedia.org/feed/' },
  ]
};

const RECENCY_CUTOFF_DAYS = 7;
const PREFERRED_RECENCY_HOURS = 48;

/**
 * Fetch a single feed, handling errors gracefully
 */
async function fetchFeed(feedConfig, category) {
  try {
    const feed = await parser.parseURL(feedConfig.url);
    return feed.items.map(item => ({
      title: item.title,
      url: item.link,
      source: feedConfig.name,
      category,
      summary: item.contentSnippet || item.content?.substring(0, 500) || null,
      publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
    }));
  } catch (error) {
    console.error(`[seed_scrape] Failed to fetch ${feedConfig.name}: ${error.message}`);
    return [];
  }
}

/**
 * Fetch all feeds and flatten into candidate list
 * Returns { items, feedCount, feedResults }
 */
async function fetchAllFeeds() {
  const allPromises = [];
  const feedNames = [];

  for (const [category, feeds] of Object.entries(FEEDS)) {
    for (const feed of feeds) {
      allPromises.push(fetchFeed(feed, category));
      feedNames.push(feed.name);
    }
  }

  const results = await Promise.all(allPromises);

  // Track which feeds returned items
  const feedResults = {};
  results.forEach((items, i) => {
    feedResults[feedNames[i]] = items.length;
  });

  return {
    items: results.flat(),
    feedCount: feedNames.length,
    feedResults
  };
}

/**
 * Filter candidates by recency
 */
function filterByRecency(candidates) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENCY_CUTOFF_DAYS);

  return candidates.filter(c => {
    if (!c.publishedAt) return false;
    return new Date(c.publishedAt) > cutoff;
  });
}

/**
 * Score a candidate based on criteria
 */
function scoreCandidate(candidate, recentTopics = []) {
  let score = 0;

  // Recency scoring
  if (candidate.publishedAt) {
    const hoursAgo = (Date.now() - new Date(candidate.publishedAt).getTime()) / (1000 * 60 * 60);
    if (hoursAgo <= PREFERRED_RECENCY_HOURS) {
      score += 30;
    } else if (hoursAgo <= 72) {
      score += 20;
    } else {
      score += 10;
    }
  }

  // Category alignment scoring
  const highAlignmentCategories = ['mutual_aid', 'cooperative', 'labor'];
  if (highAlignmentCategories.includes(candidate.category)) {
    score += 25;
  } else {
    score += 15;
  }

  // Specificity heuristics (concrete events tend to have certain keywords)
  const specificityKeywords = [
    'launched', 'opened', 'started', 'won', 'voted', 'organized',
    'workers at', 'members of', 'community', 'local', 'first'
  ];
  const titleLower = (candidate.title || '').toLowerCase();
  const summaryLower = (candidate.summary || '').toLowerCase();
  const text = titleLower + ' ' + summaryLower;

  for (const keyword of specificityKeywords) {
    if (text.includes(keyword)) {
      score += 5;
      break; // Only count once
    }
  }

  // Novelty check (penalize if topic appears in recent logs)
  for (const topic of recentTopics) {
    if (titleLower.includes(topic.toLowerCase())) {
      score -= 20;
      break;
    }
  }

  return score;
}

/**
 * Use Claude to select best seed from top candidates
 */
async function selectWithClaude(candidates, anthropicKey) {
  const client = new Anthropic({ apiKey: anthropicKey });

  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.category}] ${c.title}\n   Source: ${c.source}\n   URL: ${c.url}\n   Summary: ${c.summary?.substring(0, 200) || 'No summary'}`
  ).join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `You are selecting a seed for Comrade Claw's daily post. The seed should be:
- A concrete event, win, or development (not a think piece or hot take)
- Related to mutual aid, cooperatives, labor organizing, or post-capitalist building
- Specific enough to ground a 300-character post
- Something that matters to the project of building alternatives

Candidates:
${candidateList}

Respond with ONLY the number (1-${candidates.length}) of the best candidate, or "null" if none are suitable.
Then on a new line, briefly explain why (1-2 sentences).`
    }]
  });

  const text = response.content[0].text.trim();
  const lines = text.split('\n');
  const selection = lines[0].trim();
  const rationale = lines.slice(1).join(' ').trim();

  if (selection.toLowerCase() === 'null') {
    return { seed: null, rationale };
  }

  const index = parseInt(selection, 10) - 1;
  if (index >= 0 && index < candidates.length) {
    return { seed: candidates[index], rationale };
  }

  // Fallback to top-scored if Claude response is malformed
  return { seed: candidates[0], rationale: 'Claude selection unclear; using top-scored candidate.' };
}

/**
 * Main skill entry point
 */
export async function run({ recentLogs = [], manualSeed = null, anthropicKey }) {
  // Handle manual seed override
  if (manualSeed) {
    return {
      seed: {
        url: manualSeed.startsWith('http') ? manualSeed : null,
        title: manualSeed.startsWith('http') ? null : manualSeed,
        source: 'manual',
        category: null,
        summary: null,
        publishedAt: new Date().toISOString(),
      },
      candidates: [],
      rationale: 'Manual seed provided by operator.'
    };
  }

  // Fetch and process feeds
  console.log('[seed_scrape] Fetching feeds...');
  const feedData = await fetchAllFeeds();
  const allCandidates = feedData.items;
  console.log(`[seed_scrape] Found ${allCandidates.length} total items from ${feedData.feedCount} feeds`);

  // Filter by recency
  const recentCandidates = filterByRecency(allCandidates);
  console.log(`[seed_scrape] ${recentCandidates.length} items within recency window`);

  if (recentCandidates.length === 0) {
    return {
      seed: null,
      candidates: [],
      rationale: 'No recent items found across all feeds. Proceeding with null seed.',
      feedCount: feedData.feedCount,
      feedResults: feedData.feedResults
    };
  }

  // Extract recent topics from logs for novelty check
  const recentTopics = recentLogs
    .filter(log => log.seed?.title)
    .map(log => log.seed.title);

  // Score candidates
  const scoredCandidates = recentCandidates
    .map(c => ({ ...c, score: scoreCandidate(c, recentTopics) }))
    .sort((a, b) => b.score - a.score);

  // Take top 5 for Claude selection
  const topCandidates = scoredCandidates.slice(0, 5);

  // Select with Claude
  try {
    const { seed, rationale } = await selectWithClaude(topCandidates, anthropicKey);
    return {
      seed,
      candidates: scoredCandidates.slice(0, 10), // Log top 10 for review
      rationale,
      feedCount: feedData.feedCount,
      feedResults: feedData.feedResults
    };
  } catch (error) {
    console.error(`[seed_scrape] Claude selection failed: ${error.message}`);
    // Fallback to top-scored candidate
    return {
      seed: topCandidates[0] || null,
      candidates: scoredCandidates.slice(0, 10),
      rationale: `Claude API failed; using top-scored candidate. Error: ${error.message}`,
      feedCount: feedData.feedCount,
      feedResults: feedData.feedResults
    };
  }
}

export default { run };
