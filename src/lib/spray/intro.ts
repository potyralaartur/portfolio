/**
 * Spray intro entry (the lazily loaded chunk): wires engine, paint,
 * composite and timeline together. boot.ts imports this dynamically.
 * When the drawing is finished (schedule.end) the canvas keeps it: the composite bakes
 * it into a texture at the canvas size and everything but that texture, the
 * grain, the mask and the emitters is disposed. On scroll the baked drawing
 * runs and fades. A resize at rest lays the drawing again at the new size
 * (every play lays identical paint). The SVG shows only if the canvas fails.
 */
import { createComposite } from './composite';
import { strokeEase } from './ease';
import { createEngine, type EngineOptions } from './engine';
import { look, schedule, strokeDuration, type LayerLook } from './look';
import { createPaint, loadTexture, type Paint } from './paint';
import paths from './paths.json';
import { DripEmitter, emitAll, StrokeEmitter, type DripData, type Emitter, type StrokeData } from './splats';
import { createIntroTimeline, createScroll } from './timeline';
import masksUrl from './stroke-masks.png?url';
import grainUrl from './blue-noise.png?url';

/** Every stroke, every layer, the drips */
let ENABLED = new Set(schedule.strokes.map((s) => s.id));
let DRIPS = true;
/** Dev bench: keep the paint buffers at rest so replay and seek still work */
let KEEP = false;
/** Dev bench: ?tier=low starts on the low tier; ?slow=25 makes each intro frame take 25 ms (forces the drop) */
let TIER: 'high' | 'low' = 'high';
let SLOW = 0;
/** Dev bench filters: ?strokes=01,02 and ?layers=core,mist,halo,speckle */
let LAYERS: Set<string> | null = null;
if (import.meta.env.DEV) {
  const q = new URLSearchParams(location.search);
  if (q.get('strokes')) ENABLED = new Set(q.get('strokes')!.split(','));
  if (q.get('layers')) LAYERS = new Set(q.get('layers')!.split(','));
  if (q.has('nodrips')) DRIPS = false;
  if (q.has('keep')) KEEP = true;
  if (q.get('tier') === 'low') TIER = 'low';
  SLOW = Number(q.get('slow') ?? 0);
}

const root = document.documentElement;

export async function startSpray(opts: EngineOptions) {
  // Context loss (or any engine failure) also stops the timeline and scroll, then shows the SVG
  let teardown = () => {};
  const engine = createEngine({
    ...opts,
    tier: TIER,
    onFail(reason) {
      teardown();
      opts.onFail(reason);
    },
  });
  const [masks, grain] = await Promise.all([
    loadTexture(masksUrl),
    loadTexture(grainUrl, { repeat: true, nearest: true }),
  ]);
  // The head timeout may have shown the SVG while the textures loaded
  if (!root.classList.contains('spray')) {
    engine.dispose();
    masks.dispose();
    grain.dispose();
    return null;
  }

  let paint = createPaint(engine, masks);
  const composite = createComposite(engine, grain);
  const tier = look.tiers[engine.tier];
  const share = look.tiers[engine.tier].splatShare;

  const emitters: Emitter[] = [];
  const strokeEmitters: StrokeEmitter[] = [];
  // The low tier's mist replaces mist + halo (8-bit paint, no halo)
  const lowMist: LayerLook = { ...look.mist, ...look.tiers.low.mist };
  for (const slot of schedule.strokes) {
    if (!ENABLED.has(slot.id)) continue;
    const stroke = (paths.strokes as StrokeData[]).find((s) => s.id === slot.id)!;
    // Strokes drawn after this one (speckle keeps off them)
    const later = schedule.strokes
      .slice(schedule.strokes.indexOf(slot) + 1)
      .map((l) => (paths.strokes as StrokeData[]).find((s) => s.id === l.id)!)
      .map((l) => ({ points: l.points, half: (l.letter === '.' ? paths.stop.strokeWeight : paths.weight) / 2 }));
    const turns = (stroke as StrokeData & { turns?: { s: number; speed: number }[] }).turns;
    const rampIn = look.flyingStarts.find((f) => f.stroke === slot.id)?.length;
    const stop = stroke.letter === '.';
    // Order is the blend order within a step: overspray first, core on top, speckle last.
    // Ids seed the PRNG, so they stay fixed whichever layers a tier uses.
    const layers: [number, LayerLook, string][] = [
      ...(tier.halo ? [[1, look.halo, 'halo'] as [number, LayerLook, string]] : []),
      [2, engine.tier === 'low' ? lowMist : look.mist, 'mist'],
      [3, look.core.footprint, 'core'],
      [4, look.core.droplets, 'core'],
      [5, look.speckle, 'speckle'],
    ];
    for (const [layerIndex, layer, name] of layers) {
      if (LAYERS && !LAYERS.has(name)) continue;
      const emitter = new StrokeEmitter(stroke, layer, {
          at: slot.at,
          duration: slot.duration ?? strokeDuration(stroke.length),
          ease: strokeEase({ length: stroke.length, turns }, slot.ease, schedule.ease),
          share: layer.perStep ? 1 : share,
          orange: stop,
          layerIndex,
          rampIn,
          splits: turns?.map((t) => t.s),
          halfWidth: (stop ? paths.stop.strokeWeight : paths.weight) / 2,
          tap: stop ? { r0: look.fullStop.r0, r1: look.fullStop.r1, hardness0: look.fullStop.hardness0 } : undefined,
          alphaScale: stop && !layer.clip && !layer.ring ? look.fullStop.oversprayScale : 1,
          channel: stroke.channel,
          later: layer.avoid !== undefined ? later : undefined,
        });
      emitters.push(emitter);
      strokeEmitters.push(emitter);
    }
  }

  // Drips lay nothing: the composite draws them from their state at each moment
  const drips = DRIPS ? (paths.drips as DripData[]).map((d, i) => new DripEmitter(d, i)) : [];

  const intro = createIntroTimeline(
    () => engine.requestRender(),
    () => {
      finishing = true;
      engine.requestRender();
    },
  );
  let laidTo = 0;
  let atRest = false;
  let finishing = false;
  /**
   * The paint buffers only resample on a resize: growing loses detail (the
   * low tier's return to full resolution, a wider window). Then the finished
   * drawing is laid again at the full size; at rest, once the resize settles.
   */
  let grown = false;
  let bufferWidth = engine.size.width;
  let relayTimer = 0;
  engine.onResize((w) => {
    if (w > bufferWidth) grown = true;
    bufferWidth = w;
    if (!atRest || KEEP) return;
    clearTimeout(relayTimer);
    relayTimer = window.setTimeout(relayAtRest, look.rest.relayDelay * 1000);
  });

  // Scroll: render only when uScroll changes, and not while the hero is off screen
  const hero = opts.wrap.closest<HTMLElement>('[data-hero]') ?? opts.wrap;
  let heroVisible = true;
  new IntersectionObserver(([entry]) => {
    heroVisible = entry.isIntersecting;
    if (heroVisible) engine.requestRender();
  }).observe(hero);
  let fastForwarded = false;
  const scroll = createScroll(hero, (value) => {
    // Scrolling during the intro plays the rest of it in look.scroll.fastForward s
    if (value > 0 && !atRest && !fastForwarded && !intro.tl.paused()) {
      fastForwarded = true;
      const remaining = intro.tl.duration() - intro.tl.time();
      if (remaining > 0) intro.tl.timeScale(Math.max(intro.tl.timeScale(), remaining / look.scroll.fastForward));
    }
    if (heroVisible) engine.requestRender();
  });

  /**
   * Quality: drop to the low tier mid-play after look.slowFrames.count frames
   * in a row over look.slowFrames.ms: DPR 1, 8-bit paint (resampled), 40 % of
   * the splats, no halo.
   */
  let slow = 0;
  function watchFrame(dt: number) {
    if (engine.tier === 'low') return;
    slow = dt * 1000 > look.slowFrames.ms ? slow + 1 : 0;
    if (slow >= look.slowFrames.count) dropToLow();
  }
  function dropToLow() {
    if (engine.tier === 'low') return;
    const low = look.tiers.low;
    paint.setHalfFloat(low.halfFloat);
    engine.setTier('low'); // DPR 1: resizes, the paint is resampled
    for (const e of strokeEmitters) {
      if (e.layer === look.halo && !low.halo) e.stop();
      else if (e.layer === look.mist) e.layer = lowMist;
      else if (!e.layer.perStep) e.setShare(low.splatShare);
    }
    if (import.meta.env.DEV) console.info(`[spray] dropped to low tier at ${intro.tl.time().toFixed(2)} s`);
  }

  const textures = (p: Paint) => ({ texture: p.texture, core: p.core.texture, fog: p.fog.texture });

  /** Lays every step up to t at once (the finish and re-lays: nothing moves meanwhile) */
  function layAll(p: Paint, t: number) {
    while (emitters.some((e) => e.waiting(t))) {
      p.batch.count = emitAll(emitters, t, p.batch.data, p.batch.capacity);
      p.step(0);
    }
    composite.setDrips(drips.map((d) => d.state(t)));
  }

  /** The drawing is finished: bake it, keep showing it, free the paint buffers */
  function finish() {
    finishing = false;
    if (grown) {
      // Resampled up on the way: lay the drawing again at this size
      grown = false;
      restartPaint();
    }
    layAll(paint, schedule.end);
    composite.bake(textures(paint));
    atRest = true;
    if (!KEEP) disposePaint();
  }

  let disposed = false;
  function disposePaint() {
    if (disposed) return;
    disposed = true;
    paint.dispose();
    intro.dispose();
    // At rest: the baked drawing, with the scroll effect
    engine.setFrame(() => {
      composite.setScroll(scroll.value);
      composite.render(null);
    });
  }

  /** A resize at rest: the drawing laid again at the new size, baked, the buffers freed again */
  function relayAtRest() {
    if (!disposed) return;
    grown = false;
    paint = createPaint(engine, masks);
    emitters.forEach((e) => e.reset());
    layAll(paint, schedule.end);
    composite.bake(textures(paint));
    paint.dispose();
    engine.requestRender();
  }

  function restartPaint() {
    paint.clear();
    emitters.forEach((e) => e.reset());
    laidTo = 0;
  }

  engine.setFrame((dt) => {
    if (import.meta.env.DEV && SLOW) for (const end = performance.now() + SLOW; performance.now() < end; );
    const t = intro.tl.time();
    if (intro.tl.isActive() && t < look.tiers.low.fullResAt) watchFrame(dt);
    // Low tier: full resolution again for the last drips and the finished drawing
    if (engine.tier === 'low' && t >= look.tiers.low.fullResAt) engine.setDprCap(look.tiers.high.maxDpr);
    // Seeking backwards: repaint from the start (steps are deterministic)
    if (t < laidTo - 1e-6) restartPaint();
    laidTo = t;
    const { batch } = paint;
    batch.count = emitAll(emitters, t, batch.data, batch.capacity);
    composite.setDrips(drips.map((d) => d.state(t)));
    paint.step(dt);
    if (finishing) finish();
    composite.setScroll(scroll.value);
    composite.render(atRest ? null : textures(paint));
    // More frames while the clock runs or finished steps are still waiting for room
    if (intro.tl.isActive() || emitters.some((e) => e.waiting(t))) engine.requestRender();
  });

  teardown = () => {
    clearTimeout(relayTimer);
    intro.dispose();
    scroll.dispose();
  };

  root.classList.add('spray-live');
  intro.tl.play();
  engine.requestRender();

  return {
    engine,
    get paint() {
      return paint;
    },
    intro,
    /** The live tuning object (dev bench tunes it in place, then replays) */
    look,
    scroll,
    dropToLow,
    get atRest() {
      return atRest;
    },
    get disposed() {
      return disposed;
    },
    replay() {
      if (disposed) return location.reload();
      atRest = false;
      engine.setDprCap(null);
      restartPaint();
      intro.restart();
      engine.requestRender();
    },
    /** Freeze the intro at t (dev bench, and scroll fast-forward later) */
    seek(t: number) {
      if (disposed) return;
      atRest = false;
      intro.tl.pause(t);
      engine.requestRender();
    },
  };
}
