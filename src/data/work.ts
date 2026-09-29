/**
 * Case studies, in page order. Placeholder content mirrors the Figma filmstrips
 * (Case Study / 01-04 in "Homepage / Desktop 1441 / Filmstrip gallery", 31:174).
 * To add real work: put images in /public/work/<slug>/ and set `src` + `alt` on each slide.
 *
 * No client / role / scope / year block by design decision (Sep 2026).
 */

/** How many grid columns a slide spans. Image size at 1440: 1 = 347 x 600, 2 = 695 x 600, 3 = 1043 x 600. */
export type Span = 1 | 2 | 3;

export type Slide = {
  cols: Span;
  caption: string; // one line, two at most (max 316px wide)
  src?: string; // omitted = placeholder slot; cropped to fill (object-fit: cover)
  alt?: string;
};

export type CaseStudy = {
  slug: string;
  title: string; // no trailing period, the orange stop is added
  description: string; // 2-3 sentences
  slides: Slide[];
};

const DESC =
  'Two or three sentences on the problem, your role and the outcome. What was broken, what you changed, and what it did for the people using it and for the business.';

export const work: CaseStudy[] = [
  {
    slug: 'case-01',
    title: 'Case study title',
    description: DESC,
    slides: [
      { cols: 2, caption: 'Short caption: what this image shows and the decision behind it.' },
      { cols: 1, caption: 'One line on the problem this screen solves.' },
      { cols: 2, caption: 'Before and after, with the metric that moved.' },
      { cols: 1, caption: 'Detail of a component and why it works this way.' },
      { cols: 3, caption: 'Early exploration that shaped the final direction.' },
      { cols: 2, caption: 'Flow overview, from entry point to outcome.' },
    ],
  },
  {
    slug: 'case-02',
    title: 'Case study title',
    description: DESC,
    slides: [
      { cols: 1, caption: 'One line on the problem this screen solves.' },
      { cols: 2, caption: 'Before and after, with the metric that moved.' },
      { cols: 3, caption: 'Detail of a component and why it works this way.' },
      { cols: 1, caption: 'Early exploration that shaped the final direction.' },
      { cols: 2, caption: 'Flow overview, from entry point to outcome.' },
    ],
  },
  {
    slug: 'case-03',
    title: 'Case study title',
    description: DESC,
    slides: [
      { cols: 3, caption: 'Before and after, with the metric that moved.' },
      { cols: 2, caption: 'Detail of a component and why it works this way.' },
      { cols: 1, caption: 'Early exploration that shaped the final direction.' },
      { cols: 2, caption: 'Flow overview, from entry point to outcome.' },
      { cols: 1, caption: 'Final UI in context, on the device it ships to.' },
    ],
  },
  {
    slug: 'case-04',
    title: 'Case study title',
    description: DESC,
    slides: [
      { cols: 1, caption: 'Detail of a component and why it works this way.' },
      { cols: 1, caption: 'Early exploration that shaped the final direction.' },
      { cols: 1, caption: 'Flow overview, from entry point to outcome.' },
      { cols: 2, caption: 'Final UI in context, on the device it ships to.' },
      { cols: 3, caption: 'Short caption: what this image shows and the decision behind it.' },
      { cols: 1, caption: 'One line on the problem this screen solves.' },
    ],
  },
];
