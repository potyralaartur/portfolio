/**
 * GSAP owns time. The intro timeline is the clock: its time() drives the
 * emitters (each derives its nozzle position from it), so pause, timeScale and
 * seeking all go through GSAP. Paused while the tab is hidden. ScrollTrigger
 * drives the scroll effect's uScroll.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { look, schedule } from './look';

export interface IntroTimeline {
  tl: gsap.core.Timeline;
  restart(): void;
  dispose(): void;
}

export function createIntroTimeline(onUpdate: () => void, onComplete: () => void): IntroTimeline {
  const tl = gsap.timeline({ paused: true, onUpdate, onComplete });
  // The clock: an empty tween spanning the paint. Labels mark each stroke.
  tl.to({}, { duration: schedule.end }, 0);
  schedule.strokes.forEach((s) => tl.addLabel(`stroke-${s.id}`, s.at));
  Object.entries(schedule.drips).forEach(([id, at]) => tl.addLabel(id, at));

  let resumeOnShow = false;
  const onVisibility = () => {
    if (document.hidden) {
      resumeOnShow = tl.isActive();
      tl.pause();
    } else if (resumeOnShow) {
      resumeOnShow = false;
      tl.resume();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    tl,
    restart() {
      tl.restart();
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibility);
      tl.kill();
    },
  };
}

/**
 * uScroll 0 -> 1 as the hero scrolls from "top top" to "bottom top", scrubbed
 * (look.scroll.scrub s of smoothing). onChange fires only when it changes.
 */
const snap = (v: number) => (v < 1e-3 ? 0 : v > 1 - 1e-3 ? 1 : v);

export function createScroll(hero: HTMLElement, onChange: (value: number) => void) {
  gsap.registerPlugin(ScrollTrigger);
  const state = { value: 0 };
  let last = -1;
  const tween = gsap.to(state, {
    value: 1,
    ease: 'none',
    scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: look.scroll.scrub },
    onUpdate() {
      const v = snap(state.value);
      if (v !== last) {
        last = v;
        onChange(v);
      }
    },
  });
  return {
    /** Snapped: the scrub's easing tail would otherwise never quite reach 0 (the drawing is untouched only at exactly 0) */
    get value() {
      return snap(state.value);
    },
    dispose() {
      tween.scrollTrigger?.kill();
      tween.kill();
    },
  };
}
