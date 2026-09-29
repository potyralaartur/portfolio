/**
 * Spray intro: every tuning number lives here.
 * Units are logo units (the 240 x 84 space of Figma "Logo / PTRL. / Strokes")
 * unless a name says otherwise. Look and feel follow reference/SPRAY_ANIMATION_NOTES.md.
 */

/* Geometry: how the logo sits in Tag.astro's 1392 x 720 viewBox */
export const STAGE = { w: 1392, h: 720 };
export const STAGE_SCALE = 1280 / 240; // 5.3333, same as Tag.astro
export const STAGE_OFFSET = { x: 56, y: 136 };
/** The SVG box in logo units: the camera frustum. y points down, like SVG. */
export const VIEW = {
  left: -STAGE_OFFSET.x / STAGE_SCALE, // -10.5
  right: (STAGE.w - STAGE_OFFSET.x) / STAGE_SCALE, // 250.5
  top: -STAGE_OFFSET.y / STAGE_SCALE, // -25.5
  bottom: (STAGE.h - STAGE_OFFSET.y) / STAGE_SCALE, // 109.5
};
/** Logo rectangle */
export const LOGO = { w: 240, h: 84 };
/**
 * Rectangle logo-mask.png covers, in logo units: the logo plus a 2-unit
 * margin, so the outline's soft edge is never cropped (the P stem ends at y 83.7).
 */
export const MASK_RECT = { x: -2, y: -2, w: 244, h: 88 };

export const look = {
  weight: 11.75,

  /* Quality tiers. high: half-float paint, full splat rate; low: 8-bit, 40%, no halo */
  tiers: {
    high: { maxDpr: 2, halfFloat: true, splatShare: 1, halo: true },
    low: {
      maxDpr: 1,
      halfFloat: false,
      splatShare: 0.4,
      halo: false,
      /**
       * No halo, and 8-bit paint drops per-step fog under 1/255: one gaussian
       * mist carries the overspray alone (the tail stops at ~3.5 units).
       */
      mist: { radius: [10.5, 10.5] as [number, number], alpha: 0.1, hardness: 0 },
      /**
       * After the tap (2.96 s) only drips move: from here the canvas is back at
       * the screen's DPR (max 2), and the finished drawing is laid again at
       * that size (intro.ts). No drop to low after this.
       */
      fullResAt: 2.97,
    },
  },
  /** At rest: after a resize, the drawing is laid again at the new size once resizing has stopped this long (s) */
  rest: { relayDelay: 0.15 },
  /** Drop to low mid-play after this many consecutive slow frames */
  slowFrames: { count: 30, ms: 20 },
  /** Show the SVG and skip the intro if the canvas isn't live by then (ms). Mirrored in Base.astro. */
  bootTimeout: 1200,

  /* Build-time: logo-mask.png, the outline softened ~1 unit (notes §5 Paint / Core); stroke-masks.png is cut by it */
  mask: {
    width: 2048,
    height: 739, // 2048 x 88 / 244
    /** Gaussian blur of the outline, in logo units. ~3 sigma = the 1-unit soft edge */
    edge: 0.33,
    /**
     * Core clip = smoothstep(clip[0], clip[1], mask). The mask multiplies
     * density, so without this dense paint would turn the blur's faint tail
     * into visible paint outside the outline. Centred on 0.5, the outline.
     */
    clip: [0.4, 0.8] as [number, number], // edge alpha 0.61 at the outline, as in the end frame
    /**
     * Rough core edge: static, smooth value-noise displacement of the mask
     * lookup, units (Figma Texture 3 px = 0.56). A wobble, not grit: the
     * edge's fine grain comes from the overspray droplets (composite).
     */
    roughness: 0.3,
    /** Wobble cell, units (a second octave at half this) */
    roughCell: 0.6,
  },
  /**
   * Per-stroke core masks (build-time stroke-masks.png over MASK_RECT). A
   * stroke's core paints only inside its own shape: its centerline stroked
   * at its weight, softened and cut by the logo mask. Each stroke keeps its
   * own core and fog density (one channel per stroke colour); strokes combine
   * only in the composite, so no stroke shows a piece of another and an
   * overlap isn't painted, or fogged, twice.
   */
  strokeMask: {
    /** Outline slivers no stroke shape covers go to a stroke, grown by this (units): joins stay seamless */
    seam: 1,
    /**
     * A sliver within half weight + this (units) of several strokes is a fillet
     * at their join: it goes to the last of them, so no stroke shows a corner
     * of a join before the other stroke gets there. Slivers are < 0.5 wide.
     */
    fillet: 1.5,
    /**
     * Strokes whose shapes come closer than this (units) get different
     * channels. The core reaches ~1.6 past the edge, the fog ~7 (halo), so
     * same-channel fogs only meet in their faintest tails.
     */
    gap: 8,
  },
  /** Arc-length sampling step for paths.json */
  sampleStep: 0.25,

  /* Timing */
  nozzleSpeed: 450, // units / s, average; each stroke eases power1.inOut
  minStroke: 0.18, // s

  /**
   * Emission is by time, not distance (notes §3): a fixed simulation step,
   * splats per step = rate x step, spread along the segment the nozzle
   * covered in that step. Slow parts get heavier paint. Seeded per step, so
   * every play is identical whatever the frame rate.
   */
  sim: {
    step: 1 / 240, // s
  },
  /** Splats per second across all layers (high tier) */
  rate: 6000,
  seed: 0x5eed,
  /** Splats emitted per frame at most (instance buffer size); the rest wait a frame */
  maxSplatsPerFrame: 4096,

  /* Paint buffer */
  buffer: {
    /** Cap on the buffer's pixel width (it matches the canvas below this) */
    maxWidth: 2560,
  },
  wet: {
    /** Wetness (buffer B) decay time constant, s. Not shown: paint lands and stays (notes §1) */
    tau: 0.5,
  },

  /**
   * Core: solid paint inside the letter outline (notes §5), each stroke
   * clipped by its own mask (stroke-masks.png). A spray cone is its smooth mean deposit plus droplet noise:
   * - footprint: one soft-rimmed round deposit per simulation step at the
   *   nozzle (time-based, so slow parts get heavier). It overshoots the outline
   *   slightly so the mask draws the edge, and never reaches past `radius`.
   * - droplets: gaussian scatter around the nozzle, truncated to a disc of
   *   maxLateral; they texture the leading edge and the fringe.
   * No core splat reaches further than 7.5 units from the nozzle: the core
   * never bleeds into the next letter part. Units: logo units.
   */
  core: {
    footprint: {
      share: 0,
      perStep: 1,
      sigma: 0,
      along: 0,
      maxLateral: 0,
      radius: [7.4, 7.4] as [number, number],
      aspect: [1, 1] as [number, number],
      alpha: 1.4,
      hardness: 0.35, // between gaussian puff and flat disc
      wet: 0.2,
      clip: true,
      /**
       * Paint builds up as the cone passes: each step lays `now` of its deposit
       * at once and the rest over the next `steps` steps, at the same spot. The
       * head is soft and firms up behind the nozzle (longer at speed, as a
       * blur would be); the total, and so the finished drawing, is unchanged.
       */
      build: { now: 0.1, steps: 8 },
    },
    droplets: {
      share: 0.6, // of look.rate
      sigma: 3.0,
      along: 3.0, // the cone is round
      maxLateral: 4.4,
      // Fine grain: the soft head (footprint.build) shows them, where big ones read as bubbles
      radius: [0.25, 0.7] as [number, number],
      aspect: [1, 1.4] as [number, number], // rotated ellipses, never discs
      alpha: 0.6,
      hardness: 0.4,
      wet: 0.05,
      clip: true,
    },
  },

  /**
   * Overspray: unclipped, soft, low-density splats (notes §3, §5); they fill
   * the P and R counters. Denser at the letters than the end frame, then
   * fading out gradually: most of it within ~1.5 units of the edge, a
   * thinning spray of droplets out to ~7. Alpha by distance beyond the letter edge (the bench's
   * Profile button, averaged over 572 clean edge points):
   *   end frame:  0.5: 0.163  1: 0.10  1.5: 0.064  2: 0.048  3: 0.031  4: 0.018  5: 0.008  6+: ~0
   *   these:      0.5: 0.309  1: 0.219  1.5: 0.140  2: 0.089  3: 0.059  4: 0.039  5: 0.027  6: 0.018  7: 0.010
   *   low tier:   0.5: 0.299  1: 0.232  1.5: 0.174  2: 0.122  3: 0.057  4: 0.008  5+: 0
   * Mist is a soft-rimmed disc (hardness 0.6), not a gaussian: the dense band
   * at the letters, little of it wasted inside them. Halo (sigma 5) is the
   * long, gradual tail.
   */
  mist: {
    // One smooth soft deposit per simulation step at the nozzle: the fog's
    // mean is smooth, the grain gives it texture. Random splats read as blotches.
    share: 0,
    perStep: 1,
    sigma: 0,
    along: 0,
    maxLateral: 0,
    radius: [7.8, 7.8] as [number, number],
    aspect: [1, 1] as [number, number],
    alpha: 0.032,
    hardness: 0.6,
    wet: 0,
    clip: false,
    // No lead and no early start: fog ahead of the nozzle showed a stroke
    // (and at a join, the next one) before it was drawn
    lead: 0,
    early: 0,
    trail: 0.06, // s, keeps landing after it (ramps down)
    speedCap: 1.5, // slow parts at most 1.5x heavier: no bulbs at stroke ends (notes §4)
  },
  halo: {
    share: 0,
    perStep: 1,
    sigma: 0,
    along: 0,
    maxLateral: 0,
    radius: [15, 15] as [number, number], // sigma 5: the long, gradual tail
    aspect: [1, 1] as [number, number],
    alpha: 0.011,
    hardness: 0,
    wet: 0,
    clip: false,
    lead: 0,
    early: 0,
    trail: 0.06,
    speedCap: 1.5,
    highTierOnly: true,
  },
  /** Spit: a few tiny, hard, fully opaque dots near the stroke. Seeded, static. */
  speckle: {
    share: 12 / 6000, // ~12 dots a second, ~35 over the whole tag
    sigma: 2, // along the stroke
    along: 2,
    maxLateral: 0,
    /** Distance beyond the stroke edge (half weight), units */
    ring: [0.5, 2.5] as [number, number],
    radius: [0.1, 0.22] as [number, number],
    aspect: [1, 1.3] as [number, number],
    alpha: 3,
    hardness: 1,
    wet: 0,
    clip: false,
    /** Never smaller than this on screen, device px (at 390 wide 1 unit ~ 1.4 px) */
    minPx: 0.8,
    /** No dot within half weight + this (units) of a stroke not drawn yet: it would show before that stroke */
    avoid: 1,
  },
  /**
   * Overspray up close (notes §3, §5): the fog is mostly droplets. The paint
   * buffers carry the fog's smooth mean; the composite turns it into round,
   * solid dots, drawn procedurally in logo space at the screen's resolution
   * (static, hashed from position: the same dots every play, crisp at any
   * zoom). Three octaves of jittered-grid dots; in each cell a dot lands with
   * probability set so the mean alpha stays the tuned profile: dense and
   * merging near the letter, sparse and single further out. `haze` of the fog
   * stays smooth (more where the dots can't carry it).
   * Applies to partially transparent paint only: fog = 1 - smoothstep(fogLo, fogHi, alpha).
   */
  overspray: {
    haze: 0.2,
    /** cell (units), dot radius as a fraction of the cell [min, max], share of the droplet paint */
    octaves: [
      { cell: 0.15, r: [0.22, 0.38] as [number, number], weight: 0.5 },
      { cell: 0.3, r: [0.18, 0.34] as [number, number], weight: 0.33 },
      { cell: 0.6, r: [0.14, 0.3] as [number, number], weight: 0.17 },
    ],
    /** Droplet opacity: tiny droplets don't cover the wall fully */
    dotAlpha: 0.9,
    /** No cell under this many device px (at 390 wide 1 unit ~ 1.4 px): the finest octaves stop there, the coarse keep their size */
    minPx: 1.6,
    /** Thin fog is fine mist: below `alpha` the dots shrink, to `size` x at alpha 0 (more of them, same mean) */
    tail: { alpha: 0.12, size: 0.5 },
    fogLo: 0.55,
    fogHi: 0.95,
  },
  /**
   * Grain: a static blue-noise tile in logo space (no per-frame noise, notes
   * §3). Only the cursor smear's dissolve uses it now, as a fine dither.
   * One texel per device pixel, so it thins out finely, with no blocks.
   */
  grain: {
    tile: 64,
    /** Grain cell, units, never under minPx device px (0: always minPx) */
    size: 0,
    minPx: 1,
  },
  /**
   * Flying start (notes §4, 04): the stroke grows out of paint already there
   * (the crossbar out of the P's top bar), so it shows no start of its own:
   * every layer's paint ramps in from 0 over the first `length` units, at
   * normal spread, and the stroke's ease (schedule) starts at speed.
   */
  flyingStarts: [{ stroke: '04', length: 10 }],
  /**
   * The full stop (notes §4 row 10): the can is held still for 0.12 s; the
   * disc grows r0 -> r1 while density rises. Its layers are the strokes' layers
   * scaled by r(t) / (weight / 2), all orange (mist and halo included).
   */
  fullStop: {
    r0: 2,
    r1: 7,
    /**
     * The disc spreads as a soft blob: its footprint starts as a pure puff
     * (this hardness) and reaches the footprint's own by the end of the tap,
     * so the edge is where the paint has built up, not a circle scaling up.
     */
    hardness0: 0,
    /** Overspray around a point is a 2D gaussian, not a line: its own level */
    oversprayScale: 0.85,
  },
  /**
   * Drips (notes §6): five fixed drips from reference/strokes.json, timed
   * by schedule.drips. Drawn by the composite as one soft-edged shape
   * each (trail + bead, antialiased at the screen's resolution), from
   * DripEmitter.state(t); nothing is laid into the paint buffer.
   * Motion: the paint swells at the lip (the bead grows, the neck forms), lets
   * go, runs fast, then creeps to a stop exactly at its bead position.
   */
  drips: {
    /** Duration by length: 0.5 s up to 10 units, 0.9 s at 22 units, linear between */
    duration: { minLength: 10, min: 0.5, maxLength: 22, max: 0.9 },
    /** Opacity of the drip shape (solid) */
    alpha: 1,
    /** The trail starts this far inside the letter, units */
    inset: 1,
    /** Share of the duration the paint pools at the lip before it runs */
    swell: 0.18,
    /** How far the swollen bead hangs below the letter edge when it lets go, units */
    sag: 0.9,
    /** Bead size (x the final bead) as it swells: from, at release; back to 1 when it stops */
    bead: { from: 0.45, peak: 1.12 },
    /** Run: p(v) = 1 - (1 + kv)(1 - v)^k, still at both ends, fast early, long creep */
    release: 2.5,
    /** Stick-slip: this drip stops once at `at` of its run for `hold` of its run time */
    hesitate: { drip: 'drip-2', at: 0.6, hold: 0.12 },
    /** Bead stretch upward at full speed (x its height) */
    stretch: 0.35,
    /** Sideways drift, units, over this length (units); straight for the first `straight` units */
    wander: 0.2,
    wanderLen: 4,
    straight: 1.5,
    /** Trail width x the spec width: at the top, at the bead (mid-trail ~ the spec) */
    taper: [1.1, 0.8] as [number, number],
    /** Trail width variation (+-), over this length (units) */
    widthVar: 0.15,
    widthLen: 2.5,
    /** Neck where the paint leaves the letter: extra width (x the trail width), falloff length (units) */
    neck: { w: 0.35, len: 1.3 },
    /** Smooth union of trail and bead, x the bead radius: a teardrop, not a disc on a stick */
    smooth: 0.7,
    /** Beads are ellipses, taller than wide (Tag.astro's static beads: ry / rx = 1.15) */
    beadAspect: 1.15,
  },

  /**
   * Scroll: ScrollTrigger on the hero (start "top top", end "bottom top") drives
   * uScroll 0 -> 1. At 0 the composite shows the finished drawing untouched, so the
   * first scroll pixel changes nothing.
   */
  scroll: {
    scrub: 0.4,
    /** Scrolling during the intro plays the rest of it in this many seconds */
    fastForward: 0.4,
  },

  /**
   * Smear (composite.ts): the wet paint dragged, by the scroll (up, the way
   * the letters move as the page scrolls down) and by the cursor (smear.ts).
   * One displacement D: each pixel shows the paint from p - D; the paint
   * stretches like a thick liquid, no streaks. Units: logo units.
   */
  smear: {
    /** uScroll range over which the scroll drag grows to full */
    scroll: { range: [0, 0.6] as [number, number] },
    /** The smear fades into the untouched paint this close to the canvas edge: top (room for scroll trails), the other sides */
    edge: { top: 6, sides: 4 },
    liquid: {
      /** Scroll: stretch length across x, noise cell (units); power > 1: a few long tongues */
      cell: 22,
      max: 60,
      power: 1.4,
      /** The stretch rises from 0 at y = from to full at y = to (up); keep (from - to) > 1.5 x max so it never folds */
      ramp: { from: 130, to: -12 },
      /** Viscous wobble sideways, units at full stretch, over this length (units) */
      wobble: { amount: 0.8, cell: 9 },
    },
    /** Pointer smear: fine pointers only (hover), once the drawing is at rest */
    cursor: {
      field: 320, // field width, texels (over the whole canvas)
      radius: 7, // brush radius, units (~ the stroke weight)
      pull: 1, // share of the pointer's motion the paint follows
      maxLen: 28, // longest smear, units
      maxStep: 0.35, // a move is laid in steps of at most this x the radius: the carried paint never folds
      hold: 1.2, // s after the last touch before it dissolves
      fade: 0.8, // s to dissolve
      /** Dissolve pattern: streak segments across (units) and along the smear (units), fine grain share */
      dissolve: { across: 2.5, along: 7, grain: 0.08 },
    },
  },

  composite: {
    /** alpha = 1 - exp(-k * density). 8-bit buffers top out at density 1, so k >= 5 */
    k: 5,
    /**
     * White fog comes per stroke (paint.ts); the composite combines it as
     * max + fogOverlap x (sum - max). 1 = plain sum (every overlap fogged
     * twice), 0 = max (the densest stroke only). The end frame is one blur
     * of the whole logo: fog near joins sits between the two.
     */
    fogOverlap: 0.5,
    white: [0xf2 / 255, 0xf1 / 255, 0xee / 255] as [number, number, number],
    orange: [0xff / 255, 0x4b / 255, 0x1f / 255] as [number, number, number],
  },
};

export type Look = typeof look;

export interface LayerLook {
  /** Share of look.rate; ignored when perStep is set */
  share: number;
  /** Units ahead of the nozzle this layer lands (mist) */
  lead?: number;
  /** Seconds before / after the nozzle's pass this layer keeps landing (rate ramps) */
  early?: number;
  trail?: number;
  /** Lateral offset drawn from [min, max] beyond the stroke edge, either side (speckle) */
  ring?: [number, number];
  /** Speckle: no dot within half weight + this of a stroke not drawn yet */
  avoid?: number;
  /** Max heaviness at slow parts, relative to the average nozzle speed (overspray only) */
  speedCap?: number;
  /** Fixed splats per simulation step instead of a rate (the footprint) */
  perStep?: number;
  /** perStep only: lay `now` of each step's deposit at once, the rest spread over the next `steps` steps */
  build?: { now: number; steps: number };
  sigma: number;
  along: number;
  maxLateral: number;
  radius: [number, number];
  aspect: [number, number];
  alpha: number;
  hardness: number;
  wet: number;
  clip: boolean;
}

/**
 * Intro schedule (s). `at` is when the nozzle starts moving. A hand doesn't
 * keep one speed: each stroke has its own duration (average speed in the
 * comments, units / s), stems flick down, the crossbar is the fastest, the R's
 * tight turns the slowest. Lifts: 0.08 s within a letter, 0.16 s between
 * letters, 0.20 s before the full stop.
 */
export const schedule = {
  ease: 'power1.inOut',
  /**
   * Turns: "a hand speeds up through straight parts and eases into turns"
   * (notes §1). The build script finds sharp turns along each centerline (the
   * direction changes by more than minAngle over +-window units) and the
   * stroke slows through each one, without stopping: speed x the stroke's
   * average, from speed[0] at minAngle down to speed[1] at maxAngle. Time-based
   * emission then lays more paint there (the P's hairpin, the R's right turn,
   * the L's corner).
   */
  turns: { window: 5, minAngle: 60, maxAngle: 150, speed: [0.7, 0.35] as [number, number], endMargin: 5 },
  /**
   * reference/SPRAY_ANIMATION_NOTES.md §7 "Full schedule": the R's bowl and leg
   * are one stroke (06), so is the L (07); the full stop is 08.
   * ease: this stroke's own speed profile (the crossbar's flying start).
   */
  strokes: [
    { id: '01', at: 0.0, duration: 0.15 }, // P stem, 467: a quick downstroke
    { id: '02', at: 0.23, duration: 0.44 }, // P top and bowl, 421: the signature, careful through the hairpin
    { id: '03', at: 0.83, duration: 0.16 }, // T stem, 468
    { id: '04', at: 1.07, duration: 0.3, ease: 'power1.out' }, // crossbar, 548, the fastest: flying start, eases at the far right
    { id: '05', at: 1.53, duration: 0.15 }, // R stem, 400
    { id: '06', at: 1.76, duration: 0.48 }, // R bowl and leg, 397, the slowest: two tight turns
    { id: '07', at: 2.4, duration: 0.24 }, // L stem and foot, 445
    { id: '08', at: 2.84, duration: 0.12 }, // the full stop tap
  ] as { id: string; at: number; duration?: number; ease?: string }[],
  /**
   * Fixed drips (notes §6): R has none, T has two. Each lets go as soon as the
   * nozzle of its stroke has moved past it (its spray no longer covers the
   * drip's top), or, for the tap, when it ends. drip-3 hangs from mid-crossbar,
   * so it goes while the crossbar is still being sprayed. The build script
   * turns these into start times (paths.json).
   */
  drips: {
    'drip-1': '01', // P stem's end
    'drip-2': '03', // T stem's end
    'drip-3': '04', // mid-crossbar
    'drip-4': '07', // L foot
    'drip-5': '08', // the tap is the pool
  } as Record<string, string>,
  /** Drips 4 and 5 stop by here: the drawing is finished and stays */
  end: 3.5,
  /** Freeze-frame checks (notes §7): P done, T done, R done, L done, the tap, the end */
  checkpoints: [0.67, 1.37, 2.24, 2.64, 2.96, 3.5],
};

/** Duration of a stroke at nozzle speed */
export const strokeDuration = (length: number) => Math.max(length / look.nozzleSpeed, look.minStroke);

/** Duration of a drip by its length, top to bead centre (look.drips.duration) */
export function dripDuration(length: number) {
  const d = look.drips.duration;
  const f = Math.min(Math.max((length - d.minLength) / (d.maxLength - d.minLength), 0), 1);
  return d.min + (d.max - d.min) * f;
}
