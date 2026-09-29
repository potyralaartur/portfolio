/**
 * Horizontal case study gallery.
 * - Native scroll does the work (trackpad, touch, shift+wheel, screen readers).
 * - Mouse drag: 1:1 scrollLeft, snapping off while dragging. On release the
 *   strip keeps the hand's momentum and eases onto the slide it would coast
 *   to, in well under a second; a press, wheel, arrow or key catches it
 *   mid-glide.
 * - Arrows / Left, Right, Home, End keys: go to prev / next / first / last slide.
 * - Counter shows the range of fully visible slides ("01–02"); the progress
 *   thumb is the visible share of the strip, like a scrollbar.
 * The vertical wheel is never hijacked.
 */

const EDGE = 2; // px tolerance for "at start / at end"
const DRAG_THRESHOLD = 5; // px before a press counts as a drag
const THROW = 325; // ms: a release at v px/ms coasts about v * THROW px
const GLIDE_MS = [300, 650] as const; // glide duration, short hops to long throws
const GLIDE_MS_PER_PX = 0.3;
const VELOCITY_WINDOW = 100; // ms of pointer history the release velocity is read from
const STILL_MS = 60; // no movement this long before release = no throw
const MAX_VELOCITY = 6; // px/ms

export function initGalleries(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-gallery]').forEach(setup);
}

function setup(gallery: HTMLElement) {
  if (gallery.dataset.ready) return;
  gallery.dataset.ready = 'true';

  const track = gallery.querySelector<HTMLElement>('[data-track]')!;
  const slides = Array.from(track.querySelectorAll<HTMLElement>('[data-slide]'));
  const controls = gallery.querySelector<HTMLElement>('[data-controls]');
  const currentEl = gallery.querySelector<HTMLElement>('[data-current]');
  const thumb = gallery.querySelector<HTMLElement>('[data-thumb]');
  const prev = gallery.querySelector<HTMLButtonElement>('[data-prev]');
  const next = gallery.querySelector<HTMLButtonElement>('[data-next]');
  if (!slides.length) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const behavior = (): ScrollBehavior => (reduceMotion.matches ? 'auto' : 'smooth');

  const maxScroll = () => track.scrollWidth - track.clientWidth;
  const snapPoint = (i: number) => Math.min(slides[i].offsetLeft, maxScroll());
  const pad = (n: number) => String(n).padStart(2, '0');

  function currentIndex() {
    const x = track.scrollLeft;
    if (x >= maxScroll() - EDGE) return slides.length - 1;
    let best = 0;
    let bestDist = Infinity;
    slides.forEach((_, i) => {
      const d = Math.abs(snapPoint(i) - x);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  /** First and last slide that are fully in view; falls back to the nearest one. */
  function visibleRange(): [number, number] {
    const left = track.scrollLeft;
    const right = left + track.clientWidth;
    let first = -1;
    let last = -1;
    slides.forEach((s, i) => {
      if (s.offsetLeft >= left - EDGE && s.offsetLeft + s.offsetWidth <= right + EDGE) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) first = last = currentIndex();
    return [first, last];
  }

  function goTo(i: number) {
    const target = Math.max(0, Math.min(slides.length - 1, i));
    track.scrollTo({ left: snapPoint(target), behavior: behavior() });
  }

  // --- readout ---------------------------------------------------------------
  let frame = 0;
  function update() {
    frame = 0;
    const max = maxScroll();
    const x = track.scrollLeft;
    const fits = max <= EDGE;
    if (controls) controls.hidden = fits;
    if (thumb) {
      thumb.style.setProperty('--thumb-w', String(track.clientWidth / track.scrollWidth));
      thumb.style.setProperty('--thumb-x', String(x / track.clientWidth));
    }
    if (currentEl) {
      const [a, b] = visibleRange();
      currentEl.textContent = a === b ? pad(a + 1) : `${pad(a + 1)}–${pad(b + 1)}`;
    }
    if (prev) prev.disabled = x <= EDGE;
    if (next) next.disabled = x >= max - EDGE;
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  track.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(track);
  update();

  // --- arrows + keys -----------------------------------------------------------
  prev?.addEventListener('click', () => { stopGlide(); goTo(currentIndex() - 1); });
  next?.addEventListener('click', () => { stopGlide(); goTo(currentIndex() + 1); });
  track.addEventListener('keydown', (e) => {
    const map: Record<string, () => number> = {
      ArrowLeft: () => currentIndex() - 1,
      ArrowRight: () => currentIndex() + 1,
      Home: () => 0,
      End: () => slides.length - 1,
    };
    const fn = map[e.key];
    if (!fn) return;
    e.preventDefault();
    stopGlide();
    goTo(fn());
  });

  // --- mouse drag + momentum -------------------------------------------------
  let pointerId: number | null = null;
  let startX = 0;
  let startScroll = 0;
  let dragged = false;
  let caught = false; // the press stopped a glide in flight
  let samples: { x: number; t: number }[] = [];

  /*
   * Snapping must stay off from the first drag frame to the end of the glide:
   * switching it back on for even one layout read snaps the strip back to the
   * nearest slide. So .is-gliding goes on before .is-dragging comes off, and a
   * press that catches a glide only freezes it (hold) until the release.
   */
  let glideFrame = 0;
  function hold() {
    const moving = glideFrame !== 0;
    cancelAnimationFrame(glideFrame);
    glideFrame = 0;
    return moving;
  }
  function stopGlide() {
    hold();
    track.classList.remove('is-gliding');
  }

  /**
   * Glide onto the slide nearest to where the release velocity would coast.
   * A cubic ease that starts at the release speed and stops dead on the
   * target in a fixed time: p(u) = (s-2)u^3 + (3-2s)u^2 + su, where s is the
   * starting slope (release speed x duration / distance), kept in [0, 3] so
   * it never overshoots or backs up.
   */
  function glide(velocity: number) {
    track.classList.add('is-gliding');
    hold();
    const x0 = track.scrollLeft;
    const rest = x0 + velocity * THROW;
    let target = 0;
    let bestDist = Infinity;
    slides.forEach((_, i) => {
      const d = Math.abs(snapPoint(i) - rest);
      if (d < bestDist) { bestDist = d; target = i; }
    });
    const to = snapPoint(target);
    if (reduceMotion.matches) {
      track.scrollLeft = to;
      track.classList.remove('is-gliding');
      return;
    }
    const dist = to - x0;
    const duration = Math.min(GLIDE_MS[1], Math.max(GLIDE_MS[0], GLIDE_MS[0] + Math.abs(dist) * GLIDE_MS_PER_PX));
    const s = dist ? Math.max(0, Math.min(3, (velocity * duration) / dist)) : 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / duration);
      if (u >= 1 || Math.abs(dist) < 0.5) {
        track.scrollLeft = to;
        glideFrame = 0;
        track.classList.remove('is-gliding');
        return;
      }
      track.scrollLeft = x0 + dist * (((s - 2) * u + (3 - 2 * s)) * u + s) * u;
      glideFrame = requestAnimationFrame(step);
    };
    glideFrame = requestAnimationFrame(step);
  }

  /** px/ms over the last VELOCITY_WINDOW, positive = scrolling forward. */
  function releaseVelocity(upTime: number) {
    const last = samples[samples.length - 1];
    if (!last || upTime - last.t > STILL_MS) return 0; // paused before letting go
    const first = samples.find((s) => last.t - s.t <= VELOCITY_WINDOW) ?? last;
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    const v = (first.x - last.x) / dt;
    return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
  }

  // Wheel or trackpad takes over from a glide in flight.
  track.addEventListener('wheel', stopGlide, { passive: true });

  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) { stopGlide(); return; }
    caught = hold();
    pointerId = e.pointerId;
    startX = e.clientX;
    startScroll = track.scrollLeft;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    dragged = false;
  });

  track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!dragged && Math.abs(dx) > DRAG_THRESHOLD) {
      dragged = true;
      track.setPointerCapture(e.pointerId);
      track.classList.add('is-dragging');
    }
    if (!dragged) return;
    track.scrollLeft = startScroll - dx;
    samples.push({ x: e.clientX, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW) samples.shift();
  });

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (dragged) {
      glide(releaseVelocity(e.timeStamp));
      track.classList.remove('is-dragging');
    } else if (caught) {
      glide(0); // caught mid-glide: settle on the nearest slide
    }
    caught = false;
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // A drag should never trigger a click on something inside the track.
  track.addEventListener('click', (e) => {
    if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; }
  }, true);
}
