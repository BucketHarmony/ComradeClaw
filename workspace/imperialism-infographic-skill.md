# /imperialism-infographic — Global South Dispatch Pipeline

Full pipeline: read feeds → score for imperialism/Global South signal → template → generate → review → fix → post.

Focus: Western imperialism's material impact. How the Global South is building alternatives, resisting extraction, and emerging from the current unraveling.

---

## Step 1 — Read New Items

Call `read_new_items` (no arguments). Returns all unread items across subscribed feeds.

Priority feeds for this pipeline (score bonus applied):
- Tricontinental Institute
- Peoples Dispatch
- Monthly Review
- Africa Is a Country
- Hampton Institute
- Jacobin (international/imperialism pieces only)
- The Nation (international pieces only)

---

## Step 2 — Score and Pick Top 2

Score each item. Only pick items with score ≥ 3 — do not post weak signal.

| Signal | Points |
|--------|--------|
| From: Tricontinental, Peoples Dispatch, Monthly Review, Africa Is a Country | +4 |
| Topic: Western military intervention, sanctions, regime change | +5 |
| Topic: Global South resistance, sovereignty assertion, expulsion of foreign forces | +5 |
| Topic: Economic alternatives — nationalization, BRICS, regional currency, debt refusal | +4 |
| Topic: Climate justice, resource extraction, land dispossession | +3 |
| Topic: International solidarity, south-south cooperation | +3 |
| Concrete outcome (treaty signed, troops expelled, nationalization announced) | +2 |
| Hard number (casualties, dollar figure, % of GDP, days of blockade) | +1 |
| Strong attributable pull quote from a leader, organizer, or affected person | +1 |
| Published within 24h | +1 |
| US/Western framing presented uncritically, no structural critique | -4 |
| Pure electoral politics with no structural/solidarity angle | -3 |
| No summary or boilerplate text | -2 |

Pick the 2 highest-scoring items. Ties: prefer concrete outcome or pull quote from the Global South directly.

Announce: "Picked: [title 1] (score N, feed) + [title 2] (score N, feed)"

If fewer than 2 items score ≥ 3: note this in the report. Do not post low-signal content. Schedule a self-wake to retry in 4 hours.

---

## Step 3 — Template Match

**QUOTE CARD** — strong pull quote from a Global South leader, organizer, or affected person. Single declarative sentence. Works out of context. Attributable.

**DATA CARD** — a number that makes the extraction or resistance legible: casualties, % of GDP extracted, tons of resource, dollar value of sanctions, days of siege, worker count.

**RESISTANCE CARD** — no dominant quote or data point: headline + 3 bullets showing the arc from imperial pressure → local response → emerging alternative. Bullets must show movement, not just description.

Announce the template and why.

---

## Step 4 — Generate Graphic

Use `generate_graphic` with `png: true`, `png_scale: 2`. Canvas: `width=800`, `height=1000`.

**Color scheme — Global South Dispatch:**
- Background: `#050e07` (near-black green)
- Accent bar / highlight: `#2d6a4f` (deep forest green)
- Hot accent: `#52b788` (mid green, for numbers and quotes)
- Body text: `#e8f5e9`
- Secondary text: `#7fba9a`
- Footer bg: `#0a1a0e`
- Header label: `GLOBAL SOUTH DISPATCH`

**Before writing d3_code:** substitute ALL CAPS_PLACEHOLDERS with real values. Truncate strings to stated limits before passing. Use today's date as `APR 9, 2026` format.

### QUOTE CARD

Substitute: QUOTE_TEXT (max 120 chars), ATTRIBUTION (person/org + country), ARTICLE_TITLE_MAX55, TODAY_DATE.

```javascript
width = 800; height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#050e07');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#52b788');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#52b788').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('GLOBAL SOUTH DISPATCH');
g.append('text').attr('x', 50).attr('y', 200).attr('fill', '#1a3d28').attr('font-size', 120).attr('font-family', 'serif').text('"');
const quoteWords = 'QUOTE_TEXT'.split(' ');
const qlines = []; let qcurr = '';
quoteWords.forEach(w => { if ((qcurr+' '+w).trim().length > 28) { qlines.push(qcurr.trim()); qcurr = w; } else { qcurr = (qcurr+' '+w).trim(); } });
if (qcurr) qlines.push(qcurr);
qlines.slice(0,4).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 260+i*68).attr('fill', '#e8f5e9').attr('font-size', 48).attr('font-family', 'serif').attr('font-style', 'italic').text(line); });
const qend = 260 + Math.min(qlines.length,4)*68;
g.append('text').attr('x', 60).attr('y', qend+50).attr('fill', '#7fba9a').attr('font-size', 22).attr('font-family', 'sans-serif').text('— ATTRIBUTION');
g.append('line').attr('x1',60).attr('x2',740).attr('y1',qend+90).attr('y2',qend+90).attr('stroke','#1a3d28').attr('stroke-width',2);
g.append('text').attr('x', 60).attr('y', qend+130).attr('fill', '#52b788').attr('font-size', 20).attr('font-family', 'sans-serif').attr('font-weight','bold').text('ARTICLE_TITLE_MAX55');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#0a1a0e');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#52b788').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#3d7a55').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

### DATA CARD

Substitute: BIG_NUMBER (max 8 chars: "170,000" "$98B" "21M bbl"), NUMBER_LABEL_MAX35 (what the number means), ARTICLE_TITLE_HERE, FEED_TITLE, TODAY_DATE.

```javascript
width = 800; height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#050e07');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#52b788');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#52b788').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('GLOBAL SOUTH DISPATCH');
g.append('text').attr('x', width/2).attr('y', 430).attr('fill', '#52b788').attr('font-size', 180).attr('font-family', 'monospace').attr('font-weight','bold').attr('text-anchor','middle').text('BIG_NUMBER');
g.append('text').attr('x', width/2).attr('y', 490).attr('fill', '#7fba9a').attr('font-size', 26).attr('font-family', 'sans-serif').attr('text-anchor','middle').text('NUMBER_LABEL_MAX35');
g.append('line').attr('x1',60).attr('x2',740).attr('y1',530).attr('y2',530).attr('stroke','#1a3d28').attr('stroke-width',2);
const titleWords = 'ARTICLE_TITLE_HERE'.split(' ');
const tlines = []; let tcurr = '';
titleWords.forEach(w => { if ((tcurr+' '+w).trim().length > 38) { tlines.push(tcurr.trim()); tcurr = w; } else { tcurr = (tcurr+' '+w).trim(); } });
if (tcurr) tlines.push(tcurr);
tlines.slice(0,3).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 590+i*46).attr('fill', '#e8f5e9').attr('font-size', 34).attr('font-family', 'sans-serif').text(line); });
const tend = 590+Math.min(tlines.length,3)*46;
g.append('text').attr('x', 60).attr('y', tend+40).attr('fill', '#3d7a55').attr('font-size', 20).attr('font-family', 'sans-serif').text('FEED_TITLE · TODAY_DATE');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#0a1a0e');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#52b788').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#3d7a55').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

### RESISTANCE CARD

Three-bullet arc: what imperialism did → how they're pushing back → what's being built instead.
Substitute: ARTICLE_TITLE_HERE (wrap at 26 chars, max 3 lines), BULLET_1/2/3 (each max 40 chars — keep tight), FEED_TITLE, TODAY_DATE.

Bullet framing guide:
- BULLET_1: the pressure / extraction / attack (what empire did)
- BULLET_2: the resistance / refusal / expulsion (what the people did)
- BULLET_3: the alternative being built (what comes next)

```javascript
width = 800; height = 1000;
svg.attr('width', width).attr('height', height);
const g = d3.select(svg.node());
g.append('rect').attr('width', width).attr('height', height).attr('fill', '#050e07');
g.append('rect').attr('x', 0).attr('y', 0).attr('width', width).attr('height', 8).attr('fill', '#52b788');
g.append('text').attr('x', 60).attr('y', 80).attr('fill', '#52b788').attr('font-size', 18).attr('font-family', 'monospace').attr('letter-spacing', 4).text('GLOBAL SOUTH DISPATCH');
const hwords = 'ARTICLE_TITLE_HERE'.split(' ');
const hlines = []; let hcurr = '';
hwords.forEach(w => { if ((hcurr+' '+w).trim().length > 26) { hlines.push(hcurr.trim()); hcurr = w; } else { hcurr = (hcurr+' '+w).trim(); } });
if (hcurr) hlines.push(hcurr);
hlines.slice(0,3).forEach((line, i) => { g.append('text').attr('x', 60).attr('y', 180+i*76).attr('fill', '#e8f5e9').attr('font-size', 60).attr('font-family', 'sans-serif').attr('font-weight','bold').text(line); });
const hend = 180 + Math.min(hlines.length,3)*76 + 30;
g.append('rect').attr('x', 60).attr('y', hend).attr('width', 680).attr('height', 4).attr('fill', '#52b788');
const bullets = ['BULLET_1_MAX40', 'BULLET_2_MAX40', 'BULLET_3_MAX40'];
const icons = ['\u2715', '\u25b6', '\u2665'];
const iconColors = ['#c0392b', '#52b788', '#2d6a4f'];
bullets.forEach((b, i) => {
  g.append('text').attr('x', 60).attr('y', hend+70+i*90).attr('fill', iconColors[i]).attr('font-size', 28).attr('font-family', 'monospace').text(icons[i]);
  g.append('text').attr('x', 100).attr('y', hend+70+i*90).attr('fill', '#cce8d4').attr('font-size', 26).attr('font-family', 'sans-serif').text(b.length > 40 ? b.slice(0,37)+'...' : b);
});
const bend = hend+70+3*90;
g.append('text').attr('x', 60).attr('y', bend+30).attr('fill', '#3d7a55').attr('font-size', 20).attr('font-family', 'sans-serif').text('FEED_TITLE · TODAY_DATE');
g.append('rect').attr('x', 0).attr('y', height-80).attr('width', width).attr('height', 80).attr('fill', '#0a1a0e');
g.append('text').attr('x', 60).attr('y', height-35).attr('fill', '#52b788').attr('font-size', 20).attr('font-family', 'monospace').text('comradeclaw.bsky.social');
g.append('text').attr('x', width-60).attr('y', height-35).attr('fill', '#3d7a55').attr('font-size', 16).attr('font-family', 'monospace').attr('text-anchor','end').text('TODAY_DATE');
```

Name files: `global-south-YYYY-MM-DD-1` and `global-south-YYYY-MM-DD-2`.

---

## Step 5 — Review the PNG

After each `generate_graphic`, inspect the PNG. Check:

1. **Text clipping** — word cut off at right edge? Fix: reduce font size OR truncate string harder.
2. **Wrong date** — match today? Fix if not.
3. **Content below height-100** — bullets/title too low? Reduce spacing, cut a line, shrink font.
4. **Large empty gap** — looks unintentional? Tighten vertical spacing.
5. **Low contrast** — text blending into dark green background? Use `#e8f5e9` or `#52b788`.

Fix and regenerate same filename (overwrites). Max 3 attempts. After 3 failures: rebuild from scratch.

If clean: announce "Graphic N: clean."

---

## Step 6 — Post

For each article+graphic pair:
1. `bluesky_post_image` with `image_path: "workspace/graphics/global-south-YYYY-MM-DD-N.png"`
2. `mastodon_post_image` with same path

**Copy formula:**
- Lead: 1 sentence that names the structural dynamic — not a headline restatement. Name the empire. Name what's being taken or contested. Name who's pushing back.
- Article link on its own line
- Hashtags: `#GlobalSouth` `#AntiImperialism` `#Solidarity` `#Decolonize` `#SouthRising` — use 2-3, not all five every time

Bluesky: 300 char limit. Cut to the bone — the image carries more. Mastodon: 500 chars, use the room for context.

**Framing rules:**
- Never present Western framing as neutral baseline. Name the actor.
- Resistance is not "chaos" or "instability" — it is a response to a named cause.
- The Global South building alternatives is the story, not a footnote.

**Alt text (always required):** card type + key visible text + source. Example: "Resistance card: headline 'Iran Closes Strait of Hormuz', three bullets showing US sanctions → strait closure → BRICS talks accelerating. Dark green background, teal accent. From Peoples Dispatch."

---

## Step 7 — Report

Output:
- Article 1: title · template · graphic path · Mastodon URL · Bluesky URI
- Article 2: same
- Skipped items and score (so the scoring can be calibrated over time)

Update wake plan file with pipeline logged as completed task.

---

## Feed Subscriptions (as of Apr 2026)

Global South focused:
- Tricontinental Institute — theory/research, Global South socialist analysis
- Peoples Dispatch — news from movements worldwide
- Monthly Review — Marxist political economy, imperialism analysis
- Africa Is a Country — African politics, culture, resistance

Also draws from: Jacobin (int'l pieces), Hampton Institute, The Nation (int'l), CrimethInc (when relevant)
