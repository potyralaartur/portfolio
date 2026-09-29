/**
 * Spray engine shell: renderer, logo-unit camera, resize/DPR, render on demand,
 * context loss. Knows nothing about paint; callers hand it a frame function.
 * GSAP owns time: nothing here runs a loop. requestRender() draws one frame.
 */
import { OrthographicCamera, WebGLRenderer } from 'three';
import { look, VIEW } from './look';

export type Tier = keyof typeof look.tiers;

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Context created by boot.ts (with failIfMajorPerformanceCaveat) */
  gl: WebGL2RenderingContext;
  /** Element the canvas covers; observed for size */
  wrap: HTMLElement;
  tier?: Tier;
  onFail: (reason: string) => void;
}

export type FrameFn = (dt: number, now: number) => void;
export type ResizeFn = (width: number, height: number) => void;

export interface Engine {
  renderer: WebGLRenderer;
  camera: OrthographicCamera;
  readonly tier: Tier;
  /** Drawing-buffer size in device pixels */
  readonly size: { width: number; height: number };
  /** Frames drawn so far (for the idle check) */
  readonly frames: number;
  setFrame(fn: FrameFn | null): void;
  onResize(fn: ResizeFn): () => void;
  requestRender(): void;
  setTier(tier: Tier): void;
  /** Override the tier's DPR cap (null = the tier's) */
  setDprCap(cap: number | null): void;
  dispose(): void;
}

export function createEngine({ canvas, gl, wrap, tier: startTier = 'high', onFail }: EngineOptions): Engine {
  const renderer = new WebGLRenderer({
    canvas,
    context: gl,
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  // Logo units, y down like the SVG. top < bottom flips the projection.
  const camera = new OrthographicCamera(VIEW.left, VIEW.right, VIEW.top, VIEW.bottom, -1, 1);

  let tier: Tier = startTier;
  let dprCap: number | null = null;
  let frame: FrameFn | null = null;
  let raf = 0;
  let last = 0;
  let frames = 0;
  let disposed = false;
  const size = { width: 0, height: 0 };
  const resizeFns = new Set<ResizeFn>();

  function applySize() {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap ?? look.tiers[tier].maxDpr);
    renderer.setPixelRatio(dpr);
    renderer.setSize(rect.width, rect.height, false);
    const w = canvas.width;
    const h = canvas.height;
    if (w === size.width && h === size.height) return;
    size.width = w;
    size.height = h;
    resizeFns.forEach((fn) => fn(w, h));
    requestRender();
  }

  const ro = new ResizeObserver(applySize);
  ro.observe(wrap);
  // DPR changes (window moved between screens) don't resize the element
  let dprQuery: MediaQueryList | null = null;
  const watchDpr = () => {
    dprQuery?.removeEventListener('change', onDpr);
    dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    dprQuery.addEventListener('change', onDpr);
  };
  const onDpr = () => {
    watchDpr();
    applySize();
  };
  watchDpr();

  function draw(now: number) {
    raf = 0;
    if (disposed || !frame) return;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
    last = now;
    frames++;
    frame(dt, now / 1000);
  }

  function requestRender() {
    if (!raf && !disposed) raf = requestAnimationFrame(draw);
  }

  function onLost(e: Event) {
    e.preventDefault();
    fail('context lost');
  }
  canvas.addEventListener('webglcontextlost', onLost);

  function fail(reason: string) {
    if (disposed) return;
    engine.dispose();
    onFail(reason);
  }

  applySize();

  const engine: Engine = {
    renderer,
    camera,
    get tier() {
      return tier;
    },
    size,
    get frames() {
      return frames;
    },
    setFrame(fn) {
      frame = fn;
      last = 0;
    },
    onResize(fn) {
      resizeFns.add(fn);
      if (size.width) fn(size.width, size.height);
      return () => resizeFns.delete(fn);
    },
    requestRender,
    setTier(next) {
      if (next === tier) return;
      tier = next;
      size.width = 0; // force the resize callbacks
      applySize();
    },
    setDprCap(cap) {
      if (cap === dprCap) return;
      dprCap = cap;
      applySize();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dprQuery?.removeEventListener('change', onDpr);
      canvas.removeEventListener('webglcontextlost', onLost);
      resizeFns.clear();
      frame = null;
      renderer.dispose();
    },
  };
  return engine;
}
