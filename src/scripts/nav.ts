/**
 * Sticky nav: fades in once the hero has fully left the viewport, fades out
 * when it comes back. Reduced motion: shown / hidden instantly, no tween.
 */
import { gsap } from 'gsap';

export function initStickyNav(nav: HTMLElement, hero: HTMLElement) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const show = (visible: boolean) => {
    const vars = { autoAlpha: visible ? 1 : 0 };
    if (reduce.matches) gsap.set(nav, vars);
    else gsap.to(nav, { ...vars, duration: 0.3, ease: 'power2.out', overwrite: true });
  };

  new IntersectionObserver(([entry]) => show(!entry.isIntersecting)).observe(hero);
}
