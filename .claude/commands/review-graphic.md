# Review and Fix a Graphic

You are reviewing a generated SVG/PNG graphic for visual problems, then fixing them.

## Steps

1. **Read the SVG file** — the image path will be provided as $ARGUMENTS (e.g. `workspace/graphics/foo.svg`). Read the SVG source to understand the current layout, text content, dimensions, and positioning.

2. **View the PNG** (if it exists) — read `workspace/graphics/<filename>.png` as an image to see what it looks like visually.

3. **Check for these common problems:**
   - Text clipping at edges (right/left/top/bottom)
   - Text overflow beyond bounding containers
   - Date/timestamp errors (wrong date)
   - Color contrast issues (text hard to read over background)
   - Truncated words or cut-off letters
   - Unbalanced whitespace or crowded layout
   - Misaligned elements
   - Missing or broken elements

4. **Report what you find** — list each problem clearly: what it is, where it is, what caused it.

5. **Fix the SVG** — edit the SVG source directly using the Edit tool to correct each problem. Common fixes:
   - Text clipping: reduce font-size, add letter-spacing: tighter, break to two lines, or shrink the text element's x/width
   - Date errors: update to correct date
   - Layout: adjust x/y/width/height attributes

6. **Regenerate the PNG** — after fixing the SVG, call `mcp__claw-graphics__generate_graphic` with the corrected d3_code to produce a fresh PNG. Set `png: true`.

7. **Confirm the fix** — read the new PNG as an image and verify the problem is gone.

## Usage

```
/review-graphic workspace/graphics/union-democracy.svg
```
