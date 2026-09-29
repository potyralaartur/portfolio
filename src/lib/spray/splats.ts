/**
 * Splat emission by time, not distance (reference notes §3). Drips are not
 * emitted: DripEmitter gives the composite their shape at each moment. Time runs in
 * fixed simulation steps (look.sim.step). Each step emits rate x step splats,
 * spread along the segment the nozzle covered during that step, so slow parts
 * (starts, ends, turns) get heavier paint and fast parts never leave gaps.
 * The PRNG is seeded per (stroke, layer, step): every play is identical,
 * whatever the frame rate or however the steps fall into frames.
 */
import { look, type LayerLook } from './look';

export interface StrokeData {
  id: string;
  letter: string;
  length: number;
  points: number[];
  /** Channel of its core mask in stroke-masks.png (build script) */
  channel: number;
}

/**
 * Per-splat floats: x, y, radius, alpha, hardness, target, orange, wet, angle, aspect (minor axis = radius / aspect).
 * target: 0 = the paint buffer, channel + 1 = a stroke's core (clipped; + ODD_PART when an odd
 * part of the stroke lays it: its mask is in A), -(channel + 1) = a white stroke's fog.
 */
export const SPLAT_FLOATS = 10;
/** Added to a core splat's target when an odd part of its stroke lays it (paint.ts) */
export const ODD_PART = 10;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Position and unit tangent at arc length s (points are sampled every look.sampleStep) */
export function pointAt(points: number[], s: number, out = { x: 0, y: 0, tx: 1, ty: 0 }) {
  const n = points.length / 2;
  if (n === 1) {
    out.x = points[0];
    out.y = points[1];
    return out;
  }
  const f = Math.min(Math.max(s / look.sampleStep, 0), n - 1.0001);
  const i = Math.floor(f);
  const t = f - i;
  const x0 = points[i * 2];
  const y0 = points[i * 2 + 1];
  const x1 = points[i * 2 + 2];
  const y1 = points[i * 2 + 3];
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  out.tx = (x1 - x0) / len;
  out.ty = (y1 - y0) / len;
  return out;
}

const hash = (...n: number[]) => n.reduce((h, v) => Math.imul(h ^ v, 0x9e3779b1) ^ (h >>> 15), look.seed | 0) >>> 0;

export interface EmitterOptions {
  /** Start and duration of the nozzle's pass, s */
  at: number;
  duration: number;
  ease: (p: number) => number;
  /** Tier share of the splat rate (low tier keeps fewer, denser splats) */
  share: number;
  orange: boolean;
  layerIndex: number;
  /** Flying start: paint ramps in from 0 over this many units (look.flyingStarts) */
  rampIn?: number;
  /** Half the stroke weight: speckle rings sit beyond this */
  halfWidth: number;
  /** The full stop: a tap whose disc grows from r0 to r1 over the pass */
  tap?: { r0: number; r1: number };
  /** Extra alpha factor (the full stop's overspray level) */
  alphaScale?: number;
  /** This stroke's channel in stroke-masks.png (paths.json): its core and fog keep their own density */
  channel: number;
  /** Strokes not drawn yet (centerline samples, half weight): speckle keeps off them */
  later?: { points: number[]; half: number }[];
  /** Arc lengths of the stroke's turns: its core mask is split there (stroke-masks.png) */
  splits?: number[];
}

/** Anything emitAll() can lay: whole simulation steps, in order */
export interface Emitter {
  reset(): void;
  readonly done: boolean;
  waiting(t: number): boolean;
  readyStep(t: number): number;
  readonly nextCount: number;
  layNext(out: Float32Array, into: number): number;
}

/**
 * One layer of one stroke, laid one whole simulation step at a time (steps
 * are never split). emitAll() below drives all emitters in time order.
 */
export class StrokeEmitter implements Emitter {
  private next: number;
  /** Running splat count (fractional): carries the remainder between steps */
  private acc = 0;
  private readonly first: number;
  private readonly last: number;
  private rate: number;
  private off = false;
  private readonly p = { x: 0, y: 0, tx: 1, ty: 0 };

  constructor(
    readonly stroke: StrokeData,
    public layer: LayerLook,
    readonly opts: EmitterOptions,
  ) {
    const h = look.sim.step;
    // Mist starts before the nozzle and trails after it
    this.first = Math.round((opts.at - (layer.early ?? 0)) / h);
    this.last = Math.round((opts.at + opts.duration + (layer.trail ?? 0)) / h); // exclusive
    this.next = this.first;
    this.rate = look.rate * layer.share * opts.share;
  }

  reset() {
    this.next = this.first;
    this.acc = 0;
  }

  /** Tier change mid-play: the share of the splat rate from here on */
  setShare(share: number) {
    this.opts.share = share;
    this.rate = look.rate * this.layer.share * share;
  }

  /** Tier change mid-play: this layer stops (the low tier has no halo) */
  stop() {
    this.off = true;
  }

  get done() {
    return this.off || this.next >= this.last;
  }

  /** Finished steps still waiting to be laid (the frame ran out of room) */
  waiting(t: number) {
    return !this.done && (this.next + 1) * look.sim.step <= t + 1e-9;
  }

  /** Where this layer lands at time t: the nozzle's arc length, plus the layer's lead */
  sAt(t: number) {
    const { at, duration, ease } = this.opts;
    const p = Math.min(Math.max((t - at) / duration, 0), 1);
    const L = this.stroke.length;
    return Math.min(L, L * ease(p) + (this.layer.lead ?? 0));
  }

  /** Rate factor for step k: 1 during the pass, ramping in (early) and out (trail) */
  private factor(k: number) {
    const t = (k + 0.5) * look.sim.step;
    const { at, duration } = this.opts;
    const early = this.layer.early ?? 0;
    const trail = this.layer.trail ?? 0;
    if (t < at) return early ? Math.max(0, (t - (at - early)) / early) : 0;
    if (t > at + duration) return trail ? Math.max(0, 1 - (t - at - duration) / trail) : 0;
    return 1;
  }

  /** Splats in step k (deterministic carry: counts sum exactly to rate x time) */
  private count(k: number) {
    if (this.layer.perStep) return this.factor(k) > 0 ? this.layer.perStep : 0;
    const per = this.rate * look.sim.step * this.factor(k);
    return Math.floor(this.acc + per) - Math.floor(this.acc);
  }

  /** Next step index to lay, if it has finished by time t (else Infinity) */
  readyStep(t: number) {
    return this.waiting(t) ? this.next : Infinity;
  }

  /** Splats the next step will write */
  get nextCount() {
    return this.count(this.next);
  }

  /** Lays the next step at `into`. Returns splats written. */
  layNext(out: Float32Array, into: number) {
    const c = this.count(this.next);
    if (!this.layer.perStep) this.acc += this.rate * look.sim.step * this.factor(this.next);
    this.step(this.next, c, out, into);
    this.next++;
    return c;
  }

  private step(k: number, count: number, out: Float32Array, into: number) {
    const h = look.sim.step;
    const { layer, opts, stroke, p } = this;
    const rand = mulberry32(hash(Number(stroke.id), opts.layerIndex, k));
    const s0 = this.sAt(k * h);
    const s1 = this.sAt((k + 1) * h);
    const [r0, r1] = layer.radius;
    const [a0, a1] = layer.aspect;
    // Low tier: fewer splats, each denser, same total paint
    let alpha = (layer.alpha / opts.share) * (opts.alphaScale ?? 1);
    // The tap: everything scales with the growing disc (layers are designed for a stroke's half width)
    let scale = 1;
    let halfWidth = opts.halfWidth;
    if (opts.tap) {
      const p = Math.min(Math.max(((k + 0.5) * h - opts.at) / opts.duration, 0), 1);
      const r = opts.tap.r0 + (opts.tap.r1 - opts.tap.r0) * opts.ease(p);
      scale = r / (look.weight / 2);
      halfWidth = r;
    }
    // Per-step deposits carry the ramp in their alpha (rate layers ramp their count)
    if (layer.perStep) alpha *= this.factor(k);
    // Overspray: heaviness at slow parts capped at speedCap x the average
    if (layer.speedCap) {
      const v = Math.abs(s1 - s0) / h;
      alpha *= Math.min(1, (layer.speedCap * Math.max(v, 0.15 * look.nozzleSpeed)) / look.nozzleSpeed);
    }

    for (let i = 0; i < count; i++) {
      const s = s0 + (s1 - s0) * (layer.perStep ? (i + 0.5) / count : rand());
      // Flying start: no start of its own. Soft deposits fade in, droplets and dots thin in
      const ramp = opts.rampIn ? Math.min(1, s / opts.rampIn) : 1;
      const keep = layer.perStep ? 1 : ramp;
      // Offset from the nozzle: 2D gaussian, truncated to a disc of maxLateral,
      // so offset + splat radius never passes maxLateral + radius[1] in any direction
      const max = layer.maxLateral;
      let lateral = 0;
      let along = 0;
      if (layer.ring) {
        // Speckle: beyond the stroke edge, either side
        const [q0, q1] = layer.ring;
        lateral = (rand() < 0.5 ? -1 : 1) * (halfWidth + q0 + (q1 - q0) * rand());
        along = gauss(rand) * layer.along;
      } else for (let tries = 0; tries < 8; tries++) {
        lateral = gauss(rand) * layer.sigma;
        along = gauss(rand) * layer.along;
        if (lateral * lateral + along * along <= max * max) break;
        if (tries === 7) {
          const f = max / Math.hypot(lateral, along);
          lateral *= f;
          along *= f;
        }
      }
      const radius = (r0 + (r1 - r0) * rand()) * (layer.ring ? 1 : scale);
      const aspect = a0 + (a1 - a0) * rand();
      const angle = rand() * Math.PI;
      const a = alpha * (0.7 + 0.3 * rand()) * (layer.perStep ? ramp : 1);
      let kept = rand() < keep;

      if (!layer.ring) {
        lateral *= scale;
        along *= scale;
      }
      pointAt(stroke.points, s, p);
      const o = (into + i) * SPLAT_FLOATS;
      const x = p.x + p.tx * along - p.ty * lateral;
      const y = p.y + p.ty * along + p.tx * lateral;
      // A dot inside a stroke not drawn yet would show before it (and be covered once it is)
      if (layer.avoid !== undefined && opts.later) kept &&= !opts.later.some((l) => near(l.points, x, y, l.half + layer.avoid! + radius));
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = radius;
      out[o + 3] = kept ? a : 0;
      out[o + 4] = layer.hardness;
      // Core and fog of a white stroke keep their own density per channel; the rest goes to the paint buffer
      const ch = opts.channel + 1;
      // Core: the mask of the part the nozzle is in (between turns); odd parts' masks are in A
      const part = opts.splits ? opts.splits.filter((t) => t <= s).length : 0;
      out[o + 5] = layer.clip ? ch + (part % 2 ? ODD_PART : 0) : !layer.ring && !opts.orange ? -ch : 0;
      out[o + 6] = opts.orange ? 1 : 0;
      out[o + 7] = layer.wet;
      out[o + 8] = angle;
      out[o + 9] = aspect;
    }
  }
}

/** Is (x, y) within r of a centerline (samples every look.sampleStep)? */
function near(points: number[], x: number, y: number, r: number) {
  const r2 = r * r;
  for (let n = 0; n < points.length; n += 2) {
    const dx = points[n] - x;
    const dy = points[n + 1] - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

/**
 * Lays every finished step of every emitter, in strict time order (step k of
 * all emitters, in array order, before step k + 1). Additive blending then
 * happens in the same order however steps fall into frames, so half-float
 * rounding is identical on every play. Stops at a step boundary when full.
 */
export function emitAll(emitters: Emitter[], t: number, out: Float32Array, room: number) {
  let n = 0;
  for (;;) {
    let k = Infinity;
    for (const e of emitters) k = Math.min(k, e.readyStep(t));
    if (k === Infinity) return n;
    let c = 0;
    for (const e of emitters) if (e.readyStep(t) === k) c += e.nextCount;
    if (n + c > room) return n;
    for (const e of emitters) if (e.readyStep(t) === k) n += e.layNext(out, n);
  }
}

export interface DripData {
  id: string;
  x: number;
  top: number;
  /** Where the letter's outline ends below top (build script): the drip shows from here */
  edge: number;
  beadY: number;
  width: number;
  bead: number;
  color: string;
  start: number;
}

/** A drip's shape at one moment, for the composite (logo units) */
export interface DripState {
  x: number;
  /** Letter edge the drip leaves from (DripData.edge) */
  top: number;
  /** Bottom of the bead */
  bottom: number;
  /** Bead radius across */
  beadR: number;
  /** Bead stretch upward (0 = at rest) */
  stretch: number;
  /** Neck growth 0..1 */
  neck: number;
  /** Spec trail width */
  width: number;
  /** Spec length, top to bead centre: the trail's taper runs over it */
  length: number;
  orange: boolean;
  /** Seeds the wander and width noise */
  seed: number;
}

/** Still at both ends, fast early, a long creep to the stop */
function release(v: number, k: number) {
  const u = Math.min(Math.max(v, 0), 1);
  return 1 - (1 + k * u) * (1 - u) ** k;
}

/**
 * A drip (notes §6), as a function of time: nothing is laid, the composite
 * draws its shape from state(t). The paint pools at the lip (the bead swells
 * and the neck forms), lets go, runs fast, and creeps to a stop exactly at
 * its bead position, where it stays. The drip in look.drips.hesitate sticks
 * once on the way.
 */
export class DripEmitter {
  readonly duration: number;

  constructor(
    readonly drip: DripData,
    private readonly index: number,
  ) {
    const d = look.drips.duration;
    const len = drip.beadY - drip.top;
    const f = Math.min(Math.max((len - d.minLength) / (d.maxLength - d.minLength), 0), 1);
    this.duration = d.min + (d.max - d.min) * f;
  }

  get orange() {
    return this.drip.color === 'orange';
  }

  /** Run progress 0..1 at run time v 0..1 */
  private run(v: number) {
    const L = look.drips;
    const k = L.release;
    const h = L.hesitate;
    if (h.drip !== this.drip.id) return release(v, k);
    const t1 = h.at * (1 - h.hold);
    if (v < t1) return h.at * release(v / t1, k);
    if (v < t1 + h.hold) return h.at;
    return h.at + (1 - h.at) * release((v - t1 - h.hold) / (1 - t1 - h.hold), k);
  }

  /** The drip at time t, or null before it starts. Once stopped it stays at its final shape. */
  state(t: number): DripState | null {
    const { x, edge: top, beadY, bead, width, start } = this.drip;
    if (t <= start) return null;
    const L = look.drips;
    const u = Math.min((t - start) / this.duration, 1);
    const r = bead / 2;
    const lip = top + L.sag; // bead centre when it lets go
    let centre: number;
    let scale: number;
    let neck = 1;
    let stretch = 0;
    if (u < L.swell) {
      // Pooling: the bead grows out of the letter's edge
      const g = u / L.swell;
      const e = g * g * (3 - 2 * g);
      centre = top - L.inset + (lip - top + L.inset) * e;
      scale = L.bead.from + (L.bead.peak - L.bead.from) * e;
      neck = e;
    } else {
      const v = (u - L.swell) / (1 - L.swell);
      const p = this.run(v);
      centre = lip + (beadY - lip) * p;
      scale = L.bead.peak + (1 - L.bead.peak) * p;
      // Speed relative to the run's peak (~1.6 x its average for k = 2.5)
      const dv = 1e-3;
      const speed = (this.run(Math.min(v + dv, 1)) - this.run(Math.max(v - dv, 0))) / (Math.min(v + dv, 1) - Math.max(v - dv, 0));
      stretch = L.stretch * Math.min(speed / 1.6, 1);
    }
    const beadR = r * scale;
    return {
      x,
      top,
      bottom: centre + beadR * L.beadAspect,
      beadR,
      stretch,
      neck,
      width,
      length: beadY - top,
      orange: this.orange,
      seed: this.index * 7.31 + 0.5,
    };
  }
}
