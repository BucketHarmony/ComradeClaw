# Post with Image

You are distributing a generated graphic across Bluesky and Mastodon with proper alt text.

## Steps

1. **Locate the graphic** — $ARGUMENTS is the SVG or PNG path (e.g. `workspace/graphics/dual-power.svg`). Both `.svg` and `.png` should exist in `workspace/graphics/`. If the PNG is missing, regenerate via `mcp__claw-graphics__generate_graphic` with `png: true`.

2. **Review first** — run the `/review-graphic` workflow on the file before posting. Do not skip. Clipped text or wrong dates on a posted graphic is worse than not posting.

3. **Read the SVG** to understand the content — you need this to write accurate alt text and post copy.

4. **Draft alt text** — describe the visual literally (what a screen reader user needs), then the meaning. Aim for 2–4 sentences. Do not paste the post body as alt text.

5. **Draft post copy** —
   - Bluesky: ≤300 chars. Lead with the thought, not "new graphic →".
   - Mastodon: ≤500 chars. Can carry slightly more context / one extra sentence.
   - Both: include 1–2 hashtags max if any. Never use the graphic as a substitute for a real claim.

6. **Show the operator** the post drafts and alt text before posting unless this skill is invoked from an autonomous wake with explicit distribute intent.

7. **Post** — call `mcp__claw-multipost__multipost` with the image path, per-platform text, and alt text. Verify both platforms return success; if one fails, retry that platform individually.

8. **Log** — note the post in the current wake plan under a `distribute` task with the graphic filename and engagement-check time (next wake).

## Usage

```
/post-with-image workspace/graphics/dual-power.png
```
