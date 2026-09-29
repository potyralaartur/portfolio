/**
 * Section heads share one height: the Work header and every case study intro
 * (top rule to gallery) are as tall as the tallest of them, the extra space
 * going below the text. Fluid type makes their natural heights differ by
 * width, so it's measured: --head-h on the section, read by WorkHeader and
 * CaseStudy (which subtracts the gap above its gallery).
 */
export function matchHeads(section: HTMLElement) {
  const header = section.querySelector<HTMLElement>('[data-work-head]');
  const intros = Array.from(section.querySelectorAll<HTMLElement>('[data-case-intro]'));
  if (!header || !intros.length) return;

  const fit = () => {
    section.style.removeProperty('--head-h');
    const gap = parseFloat(getComputedStyle(intros[0].parentElement!).rowGap) || 0;
    const height = Math.max(
      header.getBoundingClientRect().height,
      ...intros.map((intro) => intro.getBoundingClientRect().height + gap),
    );
    section.style.setProperty('--head-h', `${height}px`);
  };

  fit();
  addEventListener('resize', fit);
  document.fonts?.ready.then(fit); // text wraps differently once the web fonts are in
}
