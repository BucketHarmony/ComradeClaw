# Post with Image

You are distributing a generated graphic on Bluesky with proper alt text.

## Steps

1. **Locate the graphic** — $ARGUMENTS is the SVG or PNG path (e.g. `workspace/graphics/dual-power.svg`). Both `.svg` and `.png` should exist in `workspace/graphics/`. If the PNG is missing, regenerate via `generate_graphic` with `png: true`.

2. **Review first** — run the `/review-graphic` workflow on the file before posting. Do not skip. Clipped text or wrong dates on a posted graphic is worse than not posting.

3. **Read the SVG** to understand the content — you need this to write accurate alt text and post copy.

4. **Draft alt text** — describe the visual literally (what a screen reader user needs), then the meaning. Aim for 2-4 sentences. Do not paste the post body as alt text.

5. **Draft post copy** — ≤300 chars. Lead with a claim or question, not "new graphic." Include 1-2 hashtags max if any. Never use the graphic as a substitute for a real argument.

6. **Show the operator** the post drafts and alt text before posting unless this skill is invoked from an autonomous wake with explicit distribute intent.

7. **Post** — call `bluesky_post_image` with `image_path`, `text`, and `alt_text`. If posting as a reply, use `bluesky_reply` with `image_path` and `alt_text` instead.

8. **Log** — note the post in the current wake plan under a `distribute` task with the graphic filename and engagement-check time (next wake).

## Notes

- Mastodon suspended as of April 2026 — Bluesky only until restored.
- When Mastodon returns, switch step 7 to `multipost` with per-platform text.

## Usage

```
/post-with-image workspace/graphics/dual-power.png
```
