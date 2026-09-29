/**
 * Spray boot: tiny, ships with the page. Runs only if the <head> gate set
 * html.spray (motion allowed, WebGL2 present). Probes a real WebGL2 context
 * on the canvas, then loads the intro chunk after first paint, when idle.
 * Any failure removes html.spray, which shows the SVG.
 */

export type SprayReady = NonNullable<Awaited<ReturnType<typeof import('./intro').startSpray>>>;

const root = document.documentElement;

export function failSpray(reason: string) {
  root.classList.remove('spray', 'spray-live');
  if (import.meta.env.DEV) console.info(`[spray] SVG only: ${reason}`);
}

function saveData() {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !!c?.saveData;
}

function probe(canvas: HTMLCanvasElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'reduced motion';
  if (saveData()) return 'save-data';
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: 'high-performance',
    failIfMajorPerformanceCaveat: true,
  });
  return gl ?? 'no WebGL2 (or major performance caveat)';
}

const afterPaint = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const idle = () =>
  new Promise<void>((r) =>
    'requestIdleCallback' in window ? requestIdleCallback(() => r(), { timeout: 400 }) : setTimeout(r, 50),
  );

const log = (step: string) => import.meta.env.DEV && console.info(`[spray] ${step} @ ${Math.round(performance.now())}ms`);

export async function boot(canvas: HTMLCanvasElement, wrap: HTMLElement) {
  log('boot');
  if (!root.classList.contains('spray')) return;
  const gl = probe(canvas);
  if (typeof gl === 'string') return failSpray(gl);

  try {
    await Promise.all([document.fonts.ready, afterPaint()]);
    log('fonts + first paint');
    await idle();
    log('idle');
    // The head timeout may already have shown the SVG: then never download the engine
    if (!root.classList.contains('spray')) return log('timed out before import');
    const { startSpray } = await import('./intro');
    log('intro chunk');
    // The head timeout may have given up on us meanwhile: stay SVG-only.
    if (!root.classList.contains('spray')) return;
    const ready = await startSpray({ canvas, gl, wrap, onFail: failSpray });
    log('live');
    if (ready) canvas.dispatchEvent(new CustomEvent<SprayReady>('spray:ready', { detail: ready }));
  } catch (err) {
    failSpray(String(err));
  }
}
