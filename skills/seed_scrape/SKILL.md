# seed_scrape

Fetch RSS feeds from FALGSC-aligned sources, score candidates, return best seed or null.

## Trigger

Daily cron (9am) or manual via `post now` / `draft` operator command.

## Inputs

- `recentLogs`: Last 7 session logs (for novelty deduplication)
- `manualSeed`: Optional URL or text queued via `seed: [URL]` command

## Outputs

```json
{
  "seed": {
    "url": "string or null",
    "title": "string or null",
    "source": "string or null",
    "category": "mutual_aid | cooperative | labor | theory | local | null",
    "summary": "string or null",
    "publishedAt": "ISO timestamp or null"
  },
  "candidates": ["array of scored candidates for logging"],
  "rationale": "string explaining selection or null decision"
}
```

## Feed Sources

### Cooperative Economics
- USFWC (US Federation of Worker Cooperatives)
- NCBA CLUSA (National Cooperative Business Association)
- Democracy at Work

### Mutual Aid
- Mutual Aid Hub
- Waging Nonviolence

### Labor Organizing
- Labor Notes
- In These Times

### Theory / Left Press
- Jacobin
- The Dig (podcast feed)

### Local Michigan
- Bridge Michigan
- Outlier Media

## Scoring Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| Recency | High | Published within 48 hours preferred; older items deprioritized |
| Mission alignment | High | Mutual aid, cooperative economics, post-capitalist organizing |
| Specificity | Medium | Concrete events beat trend pieces |
| Novelty | Medium | Dedupe against last 7 session logs by topic/URL |

## Selection Process

1. Fetch all configured RSS feeds
2. Filter to items published within 7 days (hard cutoff)
3. Score each candidate on criteria above
4. Submit top 5 candidates to Claude Sonnet for final selection
5. Return selected seed or null if nothing suitable

## Null Seed

If no suitable candidates exist — feeds down, nothing resonant, all stale — return null seed. This is valid. The post generation step handles null seed explicitly. Day 203 happened.

## Error Handling

- Feed timeout: Skip feed, continue with others
- All feeds fail: Return null seed with error context
- Claude API failure: Fall back to highest-scored candidate without LLM selection
