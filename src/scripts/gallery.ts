/**
 * Horizontal case study gallery.
 * - Native scroll does the work (trackpad, touch, shift+wheel, screen readers).
 * - Mouse drag: 1:1 scrollLeft, snapping off while dragging, then glide to the
 *   slide the release velocity points at.
 * - Arrows / Left, Right, Home, End keys: go to prev / next / first / last slide.
 * - Counter shows the range of fully visible slides ("01–02"); the progress
 *   thumb is the visible share of the strip, like a scrollbar.
 * The vertical wheel is never hijacked.
 */

const EDGE = 2; // px tolerance for "at start / at end"
const DRAG_THRESHOLD = 5; // px before a press counts as a drag

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
  prev?.addEventListener('click', () => goTo(currentIndex() - 1));
  next?.addEventListener('click', () => goTo(currentIndex() + 1));
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
    goTo(fn());
  });

  // --- mouse drag --------------------------------------------------------------
  let pointerId: number | null = null;
  let startX = 0;
  let startScroll = 0;
  let dragged = false;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0; // px per ms, positive = content moving left (scrolling forward)

  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    pointerId = e.pointerId;
    startX = lastX = e.clientX;
    startScroll = track.scrollLeft;
    lastT = e.timeStamp;
    velocity = 0;
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
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = 0.8 * ((lastX - e.clientX) / dt) + 0.2 * velocity;
    lastX = e.clientX;
    lastT = e.timeStamp;
  });

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    if (!dragged) return;
    track.classList.remove('is-dragging');
    // Project where a glide would stop, then settle on the nearest slide there.
    const projected = track.scrollLeft + velocity * 220;
    let target = 0;
    let bestDist = Infinity;
    slides.forEach((_, i) => {
      const d = Math.abs(snapPoint(i) - projected);
      if (d < bestDist) { bestDist = d; target = i; }
    });
    goTo(target);
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // A drag should never trigger a click on something inside the track.
  track.addEventListener('click', (e) => {
    if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; }
  }, true);
}
