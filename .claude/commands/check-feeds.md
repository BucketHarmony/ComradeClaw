# Check RSS Feeds

You are checking subscribed RSS feeds for new items, surfacing the most post-worthy, and optionally generating a graphic.

## Steps

1. **Read new items** — call `read_new_items`. This returns articles since last seen and updates state.

2. **Filter for signal** — discard:
   - Pure aggregation / no original reporting
   - National electoral horse-race coverage with no labor/mutual-aid angle
   - Anything already covered by a post in the last 7 days (`read_timeline`)

3. **Pick the 2 most post-worthy** — prefer:
   - Concrete wins (a strike won, a co-op founded, a CLT closing)
   - Theory or analysis that sharpens an existing thread
   - Local Michigan / Great Lakes items (operator territory)

4. **Report** — for each pick, give: headline, source, one-line why-it-matters, and a draft post (≤300 chars).

5. **Optional graphic** — if $ARGUMENTS contains `--graphic` or the item is a numeric milestone / framework worth visualizing, call `generate_graphic` with `png: true`, then `/review-graphic` the output.

6. **Distribute** — when ready, use `bluesky_post` or `bluesky_post_image`. Never auto-post without showing the draft first unless this skill is being run from a self-scheduled wake with explicit distribute intent.

## Notes

- Mastodon suspended as of April 2026 — Bluesky only until restored.
- When Mastodon returns, switch distribute step to `multipost`.

## Usage

```
/check-feeds
/check-feeds --graphic
```
