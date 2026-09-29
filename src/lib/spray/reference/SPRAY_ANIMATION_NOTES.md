# PTRL. spray-in: how it should be drawn

Art direction for the Three.js spray intro. Read this with the implementation prompt. Where this file and the prompt disagree on look or feel, this file wins; the prompt wins on architecture.

Files in this folder:

| File | What it is |
| --- | --- |
| `strokes.json` | The 8 centerlines (smooth cubic Béziers, 1–6 segments each) (`d`, length, start, end), stroke weight, full stop, and the 5 drips, all in logo units |
| `stroke-map.png` | Every stroke with its number, start dot, end ring and direction arrows, plus the drips, on a 10-unit grid |
| `hero-tag-end-frame.png` | The Figma end frame (hero stage 24:121, 1392 × 720) on the page background. The finished intro must match this |

Put them in the repo at `src/lib/spray/reference/` so they're versioned with the code.

---

## 1. The feel

One person, one can, one confident pass. The tag should look **written**, not plotted: fast, fluid strokes with small changes of speed, the way a hand speeds up through straight parts and eases into turns. Paint lands and stays. The only thing that moves after landing is a drip.

It must not read as:

- a vector line drawing itself (uniform width, constant speed, hard edges)
- smoke or glow (too much blur, soft all the way through, no solid core)
- confetti (visible individual splats, a sparkly or shimmering surface)

---

## 2. Space and scale

- **Logo units:** the logo is 240 × 84 units. All coordinates in `strokes.json` use this space, with the same origin as the Figma component "Logo / PTRL. / Strokes" (38:204).
- **On the page:** at a 1440 viewport the tag is 1280 px wide, so **1 unit = 5.33 CSS px**. The hero stage is 1392 × 720, with the logo at (56, 136).
- **Stroke weight:** 11.75 units (≈ 63 px at 1440). The full stop is a disc of radius 7 at (232.92, 72.68).
- **Y grows downward.** Drips run toward +y.

---

## 3. How spray paint behaves, and the rendering rule for each

| Real behaviour | Rendering rule |
| --- | --- |
| Paint comes out as a cone: dense in the middle, thinning toward the edge | Scatter splat positions around the nozzle with a Gaussian, not uniformly. The core is solid in the middle; its sides fade into the mist |
| The longer the can stays in one place, the more paint lands | **Emit by time, not by distance:** splats per frame = rate × dt, spread along the segment the nozzle covered this frame. Slow parts (stroke starts, the P loop, the R turn, the full stop) automatically get heavier paint |
| Paint builds up; the second pass over a spot is more opaque, never brighter than the paint colour | Accumulate density, then map it to opacity with `alpha = 1 - exp(-k * density)`. Colour never exceeds #F2F1EE; it only gets more opaque |
| Overspray: a fine fog lands around every stroke | Mist and halo are low-density splats with a wide spread. They are **not** clipped to the letter shapes. They land with the nozzle, never ahead of it or before the stroke starts |
| Up close, overspray is droplets, not blur | The fog is **mostly droplets**: round, solid dots in three sizes, dense and merging near the letter, sparse and single further out, with only a faint haze between them. They're drawn at the screen's resolution, so they stay crisp at any zoom, and their mean matches the fog's tuned profile (section 5) |
| Spit: a few larger droplets land away from the stroke | Speckle: a small number of tiny, hard, fully opaque dots near the stroke. Seeded, so the same dots every play. A dot never lands where a stroke not drawn yet will go |
| Where strokes overlap or join, the wall doesn't get two coats | Each stroke paints only inside its own shape and keeps its own paint and fog; strokes are combined only at the end. Core: the densest stroke wins. Fog: the densest stroke plus half of the rest, which matches the end frame's fog near joins |
| Stroke ends are clean | Every end is round and solid out to the outline, as in the end frame, flicks included (02's left end, 06's lead-in). No widening or thinning at lift-off |
| Paint that pools where the can paused turns into a drip | Drips start only at the five fixed drip points (section 6), shortly after the stroke above them ends. The paint swells at the lip before it runs |
| Dry paint doesn't move | The droplets, grain and speckle are static once laid. **No per-frame noise animation, no shimmer** |

Blending: the canvas is transparent over #0C0C0C. Use premultiplied alpha end to end so the soft mist has no dark or light fringe. Orange is its own channel and always composites **over** white where they overlap. Never mix the two into pink.

---

## 4. The hand, stroke by stroke

Order and direction are fixed. See `stroke-map.png`. Lengths are in units.

| # | Stroke | From → to | Length | How the hand moves |
| --- | --- | --- | --- | --- |
| 01 | P · Stem | top (43.4, 15.9) → bottom (11.1, 78.1) | 70 | One fast downstroke. A brief dwell at the bottom before lifting: that pooled paint feeds drip-1 |
| 02 | P · Top & Bowl | far left (6, 19.4) → right → loop → down-left → flick (12.9, 51.6) | 185 | **The signature gesture.** Fast and nearly flat to the right; the top bar runs slightly low, hugging the P's counter, so it fills the bar right down to the counter's top edge. The only real mid-stroke slowdown is entering the rounded hairpin at x ≈ 90–96; paint is slightly heavier there. Then it whips down-left through the bowl, speeding up, crosses the stem near (26, 48) and ends in a quick flick, lifting off with a round, solid end like the end frame |
| 03 | T · Stem | top (110.2, 11.2) → bottom (73, 76.2) | 75 | Fast downstroke, short dwell at the bottom: drip-2, the longest drip |
| 04 | T · Crossbar | (48, 12.6), on the P's top bar → right end (212.1, 9.5) | 165 | The fastest, most confident stroke: one long arc. It **grows out of the P's top bar**: it starts exactly on the P top's centerline with the same direction, so it must not show a start of its own. **No dwell at the start** (flying start: ramp the emission rate up over the first ~10 units, spread at normal width). Over x 48–89 it rises gradually above the P top (0.1 → 3 units), painting the top of the bar while the P top paints its underside; its lower edge never drops below the P top's. Slight ease at the far right, rounded end |
| 05 | R · Stem | top (133.3, 26.3) → bottom (102.1, 77.3) | 60 | Fast downstroke, clean lift, no drip |
| 06 | R · Bowl & Leg | lead-in (113.2, 33.3) → across the top → turn at x ≈ 171 → down-left through the stem → tight turn at the tick (~106.8, 60) → right to (164.1, 67.5) | 190 | **One stroke.** Quick lead-in from the left, across the top, slows into the right turn, sweeps down-left and crosses the stem, snaps round a tight turn at the left tick (the hand nearly stops, so the tick gets a little extra paint), then runs right, slightly downhill, into the L's corner |
| 07 | L · Stem & Foot | top (197.5, 27.2) → corner (~167.5, 77) → right (214.2, 70.2) | 107 | **One stroke.** Fast downstroke, a quick tight rounded turn at the bottom-left corner (the hand barely slows, so the corner gets a touch more paint), then kicks out to the right with a slight upward sweep. Drip-4 falls from the foot's underside at x ≈ 196 |
| 08 | Full stop | tap at (232.92, 72.68) | – | The can is held still for ~0.12 s. The disc grows from radius ~3 to 7 while density rises, with its own **orange** mist and halo. Then drip-5 |

Speed profile inside every stroke: ease in and out (`power1.inOut`) at an average of 450 units/s, minimum 0.18 s per stroke. The crossbar (04) is the exception: it starts at speed and eases only at the far right (`power1.out`). Because emission is time-based, ends come out slightly heavier, which reads as a real hand. Keep that effect subtle: start and end blobs must stay within the letter outline, not become visible bulbs.

Nozzle lifts (nothing is emitted during a lift): 0.08 s between strokes of one letter, 0.16 s between letters, 0.20 s before the full stop.

---

## 5. End-frame targets (from Figma, converted to logo units)

The painted result at the end of the intro should look like `hero-tag-end-frame.png`. Figma builds it from three stacked copies of the logo plus drips; the splat layers should land on the same look:

| Figma layer | Figma values (at 1280 wide) | In logo units | Target for the splat layer |
| --- | --- | --- | --- |
| Paint / Core | 100%, Texture effect radius 3 px, noise 1 px | edge roughness ≈ 0.56 | Solid #F2F1EE inside the letter outline, with a slightly rough, grainy edge (the logo mask edge softened ~1 unit, plus grain) |
| Overspray / Mist | 35% opacity, layer blur 10 px, monotone noise 1.5 px at density 0.6 | blur ≈ 1.9 | A grainy fog visible ~2–3 units beyond the letter edge, peak ~35% opacity at the edge |
| Overspray / Halo | 22% opacity, layer blur 36 px, monotone noise 1 px at density 0.75 | blur ≈ 6.75 | A very faint grainy fog out to ~5–7 units beyond the edge, peak ~22% |
| Drips | Texture effect radius 2 px | – | Thin solid trails with a teardrop bead at the bottom (section 6) |

Notes:

- The grey fuzzy band around every letter in the reference is the mist + halo together. It is **grainy, not smooth**: noise is part of the look, not an afterthought. Up close the grain is droplets (section 3); from a distance they average out to the same band (the bench's Profile button compares the reference, the paint before droplets and the canvas after them).
- The full stop's mist and halo are **orange**, not white.
- The counters of the P and R are filled with mist, not left clean black.
- These replace the "spread × stroke weight" numbers in the plan, which were only placeholders. Tune splat spread and opacity until the end frame matches the table above.
- **Denser at the letters than the end frame:** most of the overspray sits within ~1.5 units of the edge (about twice the end frame's density there), then it fades out gradually as a thinning spray of droplets, out to ~7 units.

---

## 6. Drips

Five drips, fixed positions (taken from the Figma Drips frame). They're in `strokes.json` too.

| Drip | Hangs from | x | Top y | Bead centre y | Length | Trail width | Bead Ø | Colour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| drip-1 | end of 01 P · Stem | 10.69 | 77.25 | 88.99 | 11.7 | 1.31 | 2.1 | white |
| drip-2 | end of 03 T · Stem | 72.94 | 76.69 | 98.51 | 21.8 | 1.50 | 2.4 | white |
| drip-3 | underside of 04 T · Crossbar | 125.63 | 11.25 | 17.41 | 6.2 | 1.13 | 1.8 | white |
| drip-4 | underside of the foot of 07 L · Stem & Foot | 195.94 | 75.75 | 89.71 | 14.0 | 1.31 | 2.1 | white |
| drip-5 | full stop | 232.88 | 78.00 | 87.52 | 9.5 | 1.13 | 1.8 | orange |

The R has no drip, and the T has two. That's intentional; don't add more.

"Top y" is where the Figma drip starts, inside the paint. The drip shows from the letter's edge below it (`edge` in paths.json, found by the build script).

How a drip looks:

- **Neck:** where it leaves the letter the trail flares into the paint above, like a meniscus, not a T-junction.
- **Taper:** the trail thins as it runs (about 1.25× the trail width at the top, 0.8× near the bead) and varies slightly in width along its length.
- **Drift:** a very slight, seeded sideways wander (±0.2 units), straight for the first 1.5 units. A wall is never perfectly flat.
- **Teardrop bead:** the bead joins the trail smoothly, it isn't a disc on a stick. While it runs it's a little bigger and stretched upward; it relaxes to its final size and shape as it stops.
- Drawn at the screen's resolution (crisp edges at any zoom), solid, no grain.

How a drip moves:

- It starts 0.10–0.20 s after the stroke above it ends. drip-5 is the exception: it starts as soon as the tap ends.
- Start times: drip-1 at 0.28 (after 01), drip-2 at 1.16 (after 03), drip-3 at 1.61 (after 04), drip-4 at 2.85 (after 07), drip-5 at 3.02.
- **Swell** (first ~18 % of its time): the paint pools at the lip. The bead grows out of the letter's edge and the neck forms; nothing runs yet.
- **Release:** it lets go, runs fast, then creeps slowly to a stop (still at both ends, not an ease-out that starts at full speed). drip-2, the long one, sticks once on the way (stick-slip).
- Duration scales with length: 0.5 s for drips up to ~10 units, up to 0.9 s for drip-2 (22 units). It stops **exactly** at its bead position, which is where it stays in the finished drawing.
- Drips overlap the next letter being sprayed; they never hold up the timeline.

---

## 7. Timeline checkpoints

Use these as freeze-frame checks (seconds from start).

| t | What should be on screen |
| --- | --- |
| 0.67 | P complete (stem, top bar, loop, bowl, flick) |
| 1.46 | P and T complete; drip-2 running, drip-1 done |
| 2.30 | P, T, R complete; drips 1–3 done |
| 2.70 | P, T, R, L complete |
| 3.02 | Full stop tapped, orange mist around it |
| 3.55 | Drips 4 and 5 have stopped; the canvas matches `hero-tag-end-frame.png` and keeps showing it from here on |

Full schedule (seconds). It replaces the timing table in the implementation prompt:

| # | Stroke | Starts | Duration |
| --- | --- | --- | --- |
| 01 | P · Stem | 0.00 | 0.18 |
| 02 | P · Top & Bowl | 0.26 | 0.41 |
| 03 | T · Stem | 0.83 | 0.18 |
| 04 | T · Crossbar | 1.09 | 0.37 |
| 05 | R · Stem | 1.62 | 0.18 |
| 06 | R · Bowl & Leg | 1.88 | 0.42 |
| 07 | L · Stem & Foot | 2.46 | 0.24 |
| 08 | Full stop tap | 2.90 | 0.12 |
| – | Drawing finished; the canvas keeps it | 3.55 | – |

Drip start times are in section 6.

There is no handoff to the SVG: once the drawing is finished the canvas keeps it (and the scroll effect runs on it). On scroll the wet paint is **dragged upward**, the way the letters move as the page scrolls down, as if wiped by a hand. Paint moves rather than being copied: each spot keeps part of its paint and takes on paint pulled up from below, dense near the letter and thinning with distance. Letters thin where paint leaves them, fine drag lines (bristles, fingertips) streak the trails, and each line stops at its own height, so the ends are ragged. Then it's wiped off: the paint breaks up into short streak segments along the drag, between the lines first and the densest paint last, until nothing is left. The SVG tag shows only when the spray can't run: reduced motion, no WebGL2, Save-Data, a major performance caveat, or a lost WebGL context.

---

## 8. Do and don't

Do:

- keep every tuning number in `look.ts`
- use a seeded PRNG so every play is identical
- judge the look on a dark screen at 100% zoom and at 1440 wide, next to the end-frame PNG
- check it at 390 wide too: at 1 unit ≈ 1.4 px the mist and speckle must still read as spray, not as blur

Don't:

- draw the strokes as SVG or `stroke-dashoffset` lines under the hood; the paint buffer is the only source of pixels
- animate the grain or speckle after they land
- let splat quads show as squares or discs (soft falloff, rotated, varied size)
- let any texture show pixel squares up close: grain, droplets and drip edges are drawn at the screen's resolution
- leave gaps at high speed (always fill the whole segment covered in a frame)
- let the core spill outside the letter outline; only mist, halo and speckle may go outside
- show where one stroke starts inside another (a start cap, a dwell blob or a mist ring). The crossbar start is the main one: see stroke 04
- show any part of the tag before it's drawn: no core, mist or speckle in another stroke's shape, or in a later part of the same stroke (the R's leg while the bowl is being drawn), before the nozzle gets there
- leave the counters' sharp tips as soft, grey mist-only wedges: counter edges should read as crisp as the outer edges
- add drips, glow, bloom, camera moves or anything not listed here
