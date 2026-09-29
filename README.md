# ptrl.design — Portfolio 2026

Static site for the homepage in Figma ("Portfolio 2026" › Homepage › `Homepage / Desktop 1441 / Filmstrip gallery`, node 31:174).
Astro + GSAP, no CSS framework. Full spec: the "PTRL. Portfolio 2026 — Dev handoff" doc.

```sh
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
```

Requires Node 22.12+.

## Where things live

| Path | What |
| --- | --- |
| `src/styles/tokens.css` | Figma variables as CSS custom properties (`bg/base` → `--bg-base`) |
| `src/styles/type.css` | Text styles as classes (`.t-display-l`, `.t-label-m`, …) and `.stop` |
| `src/data/site.ts` | Masthead, hero meta, About, Contact copy |
| `src/data/work.ts` | Case studies: title, description, slides (column span, caption, image) |
| `src/data/logo.ts` | PTRL. outline paths exported from Figma (Logo / PTRL., 10:6) |
| `src/components/Tag.astro` | Hero tag: halo / mist / core / drips / full stop layers + SVG filters |
| `src/components/Gallery.astro` + `src/scripts/gallery.ts` | Filmstrip gallery: native scroll, drag, arrows, keys, visible-range counter, progress |
| `.page-grid` (global.css) + `.fields` (Hero.astro) | Visible column rules; the hero's 4 × 8 field grid is drawn over the tag |
| `src/lib/spray/` | WebGL spray intro (Three.js + GSAP): engine, paint buffer, splats, composite, timeline. Every tuning number is in `look.ts`; `reference/` holds the art direction notes and end frame |
| `scripts/build-spray-paths.mjs` | `npm run spray:paths`: centerlines → `paths.json`, logo mask, per-stroke core masks (each stroke paints only its own shape; strokes combine in the composite), grain tile |

## Adding a case study

Add an entry to `src/data/work.ts`. Put images in `public/work/<slug>/` and set `src` + `alt` on each slide.
Titles have no trailing period: the orange full stop is added by the component.
Each slide spans 1, 2 or 3 grid columns (`cols`). Images are cropped to fill (object-fit: cover);
export them at 2× of 347 × 600, 695 × 600 or 1043 × 600. Captions: one line, two at most.

## Status

- Desktop 1440 matches the Filmstrip gallery frame (31:174): masthead, Display/M case titles, section rules,
  column grid, filmstrip + controls, V2.0 colophon. Sep 2026.
- Tablet / mobile rules are a proposal until the 390 frame is designed: 1024–1439 fluid 4 columns,
  768–1023 2 columns, <768 1 column with name + contact side by side and a content-height hero.
  Above 1440 the tag stops growing once the hero would exceed one screen.
- Sticky nav (`StickyNav.astro` + `scripts/nav.ts`) is not in Figma: it fades in once the hero is out of view.
- Spray-in: a WebGL (Three.js) intro sprays the tag stroke by stroke from the centerlines; the canvas keeps
  the finished drawing (3.6 s) and runs / fades it on scroll. SVG only with reduced motion, no WebGL2,
  Save-Data, a major performance caveat (the engine isn't downloaded) or a lost WebGL context. Tuning bench at `/dev/spray` (dev server only);
  `?force=reduced|nowebgl2|caveat|savedata|slowboot` fakes a fallback on any page in dev.
- Lighthouse (production preview, v12): mobile 96 / 96 / 100 / 100, desktop 100 / 96 / 100 / 100
  (performance / accessibility / best practices / SEO). Accessibility loses points on `target-size`:
  stacked InfoBlock links sit on a 20px line pitch.
- `--text-tertiary` is 48% instead of Figma's 36% for WCAG AA contrast (see the comment in `tokens.css`).
- LinkedIn / Dribbble URLs in `src/data/site.ts` are placeholders.
