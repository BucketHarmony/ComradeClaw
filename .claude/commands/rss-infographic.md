# /rss-infographic — RSS to Infographic Pipeline

Full pipeline: read feeds → score → template → generate → review → fix → post.

---

## Step 1 — Read New Items

Call `read_new_items` (no arguments). Returns all unread items across subscribed feeds: `title`, `link`, `summary`, `category`, `pubDate`, `feedTitle`.

---

## Step 2 — Score and Pick Top 2

Score each item:

| Signal | Points |
|--------|--------|
| Category: labor | +4 |
| Category: co-ops or mutual-aid | +3 |
| Category: theory | +2 |
| Category: local | +2 |
| Concrete outcome (strike won, contract signed, co-op opened) | +2 |
| Hard number in title/summary (wage %, headcount, dollar amount) | +1 |
| Strong pull quote (attributable declarative sentence) | +1 |
| Published within 24h | +1 |
| National electoral politics, no local/mutual-aid angle | -3 |
| No summary / boilerplate | -2 |

Pick the 2 highest-scoring items. Ties: prefer concrete outcome or pull quote.

Announce: "Picked: [title 1] (score N) + [title 2] (score N)"

---

## Step 3 — Template Match

**QUOTE CARD** — strong pull quote: single declarative sentence, works out of context, attributable.

**DATA CARD** — specific number tells the story: wage %, worker count, dollar figure, days on strike.

**STORY CARD** — neither above: headline + 3 bullets from summary.

Announce the template and why.

---

## Step 4 — Generate Graphic

Use `generate_graphic` with `png: true`, `png_scale: 2`. Canvas: `width=800`, `height=1000`.

**Before writing d3_code:** substitute ALL CAPS_PLACEHOLDERS with real values. Truncate strings to stated limits before passing — never rely on SVG to clip. Use today's date as `APR 9, 2026` format.

### QUOTE CARD

Substitute: QUOTE_TEXT (max 120 chars), ATTRIBUTION (feed + month year), ARTICLE_TITLE_MAX55, TODAY_DATE.

```javascript
const width = 800, height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#0a0a0a');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#e63946');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#e63946').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('LABOR DISPATCH');
g.append('text').attr('x', 50).attr('y', 200).attr('fill', '#222').attr('font-size', 120).attr('font-family', 'serif').text('"');
const quoteWords = 'QUOTE_TEXT'.split(' ');
const qlines = []; let qcurr = '';
quoteWords.forEach(w => { if ((qcurr+' '+w).trim().length > 28) { qlines.push(qcurr.trim()); qcurr = w; } else { qcurr = (qcurr+' '+w).trim(); } });
if (qcurr) qlines.push(qcurr);
qlines.slice(0,4).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 260+i*68).attr('fill', '#f0f0f0').attr('font-size', 48).attr('font-family', 'serif').attr('font-style', 'italic').text(line); });
const qend = 260 + Math.min(qlines.length,4)*68;
g.append('text').attr('x', 60).attr('y', qend+50).attr('fill', '#888').attr('font-size', 22).attr('font-family', 'sans-serif').text('— ATTRIBUTION');
g.append('line').attr('x1',60).attr('x2',740).attr('y1',qend+90).attr('y2',qend+90).attr('stroke','#333').attr('stroke-width',2);
g.append('text').attr('x', 60).attr('y', qend+130).attr('fill', '#e63946').attr('font-size', 20).attr('font-family', 'sans-serif').attr('font-weight','bold').text('ARTICLE_TITLE_MAX55');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#111');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#e63946').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#555').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

### DATA CARD

Substitute: BIG_NUMBER (max 6 chars: "47%" "2,300" "$18M"), NUMBER_LABEL_MAX30, ARTICLE_TITLE_HERE, FEED_TITLE, TODAY_DATE.

```javascript
const width = 800, height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#0a0a0a');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#e63946');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#e63946').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('LABOR DISPATCH');
g.append('text').attr('x', width/2).attr('y', 430).attr('fill', '#e63946').attr('font-size', 200).attr('font-family', 'monospace').attr('font-weight','bold').attr('text-anchor','middle').text('BIG_NUMBER');
g.append('text').attr('x', width/2).attr('y', 490).attr('fill', '#aaa').attr('font-size', 26).attr('font-family', 'sans-serif').attr('text-anchor','middle').text('NUMBER_LABEL_MAX30');
g.append('line').attr('x1',60).attr('x2',740).attr('y1',530).attr('y2',530).attr('stroke','#333').attr('stroke-width',2);
const titleWords = 'ARTICLE_TITLE_HERE'.split(' ');
const tlines = []; let tcurr = '';
titleWords.forEach(w => { if ((tcurr+' '+w).trim().length > 38) { tlines.push(tcurr.trim()); tcurr = w; } else { tcurr = (tcurr+' '+w).trim(); } });
if (tcurr) tlines.push(tcurr);
tlines.slice(0,3).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 590+i*46).attr('fill', '#f0f0f0').attr('font-size', 34).attr('font-family', 'sans-serif').text(line); });
const tend = 590+Math.min(tlines.length,3)*46;
g.append('text').attr('x', 60).attr('y', tend+40).attr('fill', '#555').attr('font-size', 20).attr('font-family', 'sans-serif').text('FEED_TITLE · TODAY_DATE');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#111');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#e63946').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#555').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

### STORY CARD

Substitute: ARTICLE_TITLE_HERE (wrap at 26 chars, max 3 lines), BULLET_1/2/3 (each max 52 chars), FEED_TITLE, TODAY_DATE.

```javascript
const width = 800, height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#0a0a0a');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#e63946');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#e63946').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('LABOR DISPATCH');
const hwords = 'ARTICLE_TITLE_HERE'.split(' ');
const hlines = []; let hcurr = '';
hwords.forEach(w => { if ((hcurr+' '+w).trim().length > 26) { hlines.push(hcurr.trim()); hcurr = w; } else { hcurr = (hcurr+' '+w).trim(); } });
if (hcurr) hlines.push(hcurr);
hlines.slice(0,3).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 180+i*76).attr('fill', '#f0f0f0').attr('font-size', 60).attr('font-family', 'sans-serif').attr('font-weight','bold').text(line); });
const hend = 180 + Math.min(hlines.length,3)*76 + 30;
g.append('rect').attr('x', 60).attr('y', hend).attr('width', 680).attr('height', 4).attr('fill', '#e63946');
const bullets = ['BULLET_1_MAX52', 'BULLET_2_MAX52', 'BULLET_3_MAX52'];
bullets.forEach((b, i) => {
  g.append('text').attr('x', 60).attr('y', hend+65+i*82).attr('fill', '#e63946').attr('font-size', 32).attr('font-family', 'monospace').text('\u25b8');
  g.append('text').attr('x', 102).attr('y', hend+65+i*82).attr('fill', '#ccc').attr('font-size', 28).attr('font-family', 'sans-serif').text(b.length > 52 ? b.slice(0,49)+'...' : b);
});
const bend = hend+65+3*82;
g.append('text').attr('x', 60).attr('y', bend+30).attr('fill', '#555').attr('font-size', 20).attr('font-family', 'sans-serif').text('FEED_TITLE · TODAY_DATE');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#111');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#e63946').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#555').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

Name files: `labor-dispatch-YYYY-MM-DD-1` and `labor-dispatch-YYYY-MM-DD-2`.

---

## Step 5 — Review the PNG

After each `generate_graphic`, inspect the PNG. Check:

1. **Text clipping** — word cut off at right edge? Fix: reduce font size OR truncate string.
2. **Wrong date** — match today? Fix if not.
3. **Content below height-100** — bullets/title too low? Reduce spacing, cut a line, shrink font.
4. **Large empty gap** — looks unintentional? Tighten vertical spacing.
5. **Low contrast** — text blending into background? Use `#f0f0f0` or `#e63946`.

Fix and regenerate same filename (overwrites). Max 3 attempts. After 3 failures: rebuild from scratch.

If clean: announce "Graphic N: clean."

---

## Step 6 — Post

For each article+graphic pair:
1. `bluesky_post_image` with `image_path: "workspace/graphics/labor-dispatch-YYYY-MM-DD-N.png"`
2. `mastodon_post_image` with same path

**Copy formula:**
- Lead: 1 sentence NOT the headline — your read of why this matters now
- Article link on its own line
- 2-3 hashtags: `#Labor` `#WorkersRights` `#MutualAid` `#CoopEconomy` `#Solidarity` `#Organizing`

Bluesky: 300 char limit. Cut hashtags first if over. Mastodon: 500 chars, use the room.

**Alt text (always required):** card type + key text visible + source. Example: "Story card: headline 'Co-op Survives Acquisition Bid', three bullet points, from Labor Notes. Dark background, red accent bar."

---

## Step 7 — Report

Output:
- Article 1: title · template · graphic path · Mastodon URL · Bluesky URI
- Article 2: same
- Skipped items and why

Update wake plan file with pipeline logged as completed task.
