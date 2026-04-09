---
date: 2026-04-09
tags: [research, graphics, infrastructure]
status: active
---

# Infographic Generation — What Actually Works

Research into how Claude and other LLMs can create shareable, professional-looking graphics. Compiled April 2026.

---

## Three Viable Approaches (ranked by practicality)

### A. Raw SVG via D3 (what we have now)

Claude generates D3 code, jsdom renders server-side, outputs SVG + PNG via sharp/resvg.

- **Best for:** diagrams, charts, simple posters, network graphs
- **Limitation:** text layout is approximate in jsdom (no real font metrics), text-heavy content suffers
- **Current tool:** `generate_graphic` in claw-graphics MCP

### B. Satori + resvg (the sweet spot)

Vercel's [satori](https://github.com/vercel/satori) converts JSX + inline CSS (flexbox) into SVG. Pair with `@resvg/resvg-js` for PNG. No browser needed. Pure Node.js.

- **Supports:** flexbox, font loading (TTF/OTF/WOFF), gradients, borders, shadows, transforms, opacity
- **Does NOT support:** `calc()`, `z-index`, 3D transforms, WOFF2, interactive elements
- **Why it matters:** proper text wrapping, word-level layout, flexbox positioning — solves the biggest pain point of raw SVG (manual text placement)
- **This is how Vercel generates OG images at scale.** Battle-tested.
- **Upgrade path:** add a `generate_card` tool that takes structured input (title, subtitle, body, accent color) and renders via satori + resvg

### C. HTML + Playwright screenshot

Generate full HTML/CSS page, launch headless Chromium, screenshot it.

- **Most flexible:** full CSS support, any font, any layout, CSS Grid, custom web fonts
- **Heaviest:** requires Chromium binary (~200MB+), slower execution
- **Best for:** complex multi-element layouts when satori's CSS subset is too limiting

---

## Why LLM Graphics Look Amateur (and fixes)

### Typography
| Problem | Fix |
|---------|-----|
| References fonts that don't exist in render env | Stick to `sans-serif`, `serif`, `monospace` generics, or embed font data |
| Too many font sizes | Constrain to 2-3 sizes: title, body, caption |
| Text clipping/overflow | Always specify `text-anchor`, test bounding boxes, use `dy` for vertical |

### Color
| Problem | Fix |
|---------|-----|
| Garish or low-contrast palettes | Provide a curated palette in the prompt (exact hex values) |
| Insufficient contrast (<3:1 ratio) | Include contrast requirements in generation prompt |
| Not colorblind-safe | Use pattern fills or stroke variations as redundant encoding |

### Layout
| Problem | Fix |
|---------|-----|
| Elements overlap/misalign | Use a grid system — define explicit x/y regions before drawing |
| No whitespace | Specify padding constants: `const margin = { top: 40, right: 40, bottom: 40, left: 40 }` |
| SVG viewBox wrong | Always specify `viewBox="0 0 W H"` for fluid scaling |

### Output quality
| Problem | Fix |
|---------|-----|
| Verbose path data, excessive decimals | Post-process with SVGO (30-50% size reduction) |
| Style drift after ~5 generations | Re-anchor the design system in each prompt |

---

## Prompting Strategies That Work

### Skeletal approach (best for D3)
Start with structure, then add detail iteratively:
> "Create an 800x600 SVG with a 40px margin. Draw a centered title at y=60. Below it, a 2-column grid..."

Far better than "make an infographic about X."

### Constraint-first prompting
Specify the design system upfront: viewBox, palette (exact hex), font stack, margin/padding constants, max element count. More constraints = better output.

### Named aesthetics
Claude recognizes style names: Swiss Minimalism, Brutalism, Dark OLED Luxury, Glassmorphism. "Use Swiss Minimalism style" is more consistent than describing the style manually.

### Design tokens in CLAUDE.md
Add a theme block:
```
Graphics style: dark background (#1a1a2e), accent (#e94560), text (#eee),
font: sans-serif, 4px spacing grid, max 3 hierarchy levels
```
Prevents the default "AI slop" aesthetic (Inter font + purple gradient).

---

## Social Media Image Sizes

| Platform | Size |
|----------|------|
| OG / Twitter cards | 1200x630 |
| Instagram / square | 1080x1080 |
| Pinterest | 1000x1500 |

---

## Upgrade Path for claw-graphics

### Immediate (low effort, high impact)
- Add curated color palette + typography spec to CLAUDE.md so every `generate_graphic` call uses consistent design tokens
- Add SVGO post-processing to graphics server
- Verify `@resvg/resvg-js` for PNG conversion (pure Rust WASM, no browser, ~5MB)

### Medium-term (new tool)
- Add `generate_card` tool using **satori + resvg** for social-ready cards
- LLM provides structured data (title, subtitle, body, accent color), tool applies template
- More reliable than freeform D3 for text-heavy cards because satori handles word wrap and flexbox natively
- Standard sizes: 1200x630 (OG), 1080x1080 (square post)

### Aspirational
- Playwright-based renderer for full HTML/CSS freedom
- Enables: custom web fonts, CSS Grid, complex gradients, embedded images
- Trade-off: Chromium dependency, slower

---

## What Doesn't Work

- **Complex illustrations or organic shapes in SVG** — characters distort, multi-element compositions misalign, 10+ iteration rounds
- **Expecting consistency across a long conversation** — style drift in stroke weight, complexity, proportions after ~5 generations
- **Raw SVG for text-heavy content** — text wrapping in SVG is manual and painful. Use satori or HTML rendering instead
- **Skipping post-processing** — LLM SVG output is always verbose and needs optimization

---

## Sources

- [Satori (Vercel)](https://github.com/vercel/satori) — JSX-to-SVG, CSS subset docs
- [Claude Code Frontend Design Toolkit](https://github.com/wilwaldon/Claude-Code-Frontend-Design-Toolkit) — design skills, aesthetic presets
- [Datawrapper: Text in Data Visualizations](https://www.datawrapper.de/blog/text-in-data-visualizations) — typography hierarchy
- [SVG Genie](https://www.svggenie.com/blog/create-svg-with-claude-ai) — practical limitations, skeletal approach
