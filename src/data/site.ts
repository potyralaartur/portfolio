/** Site-wide copy. Text as in Figma "Homepage / Desktop 1441 / Filmstrip gallery" (31:174). */

export type Line = { text: string; href?: string; external?: boolean };
export type Info = { label: string; lines: Line[] };

export const person = {
  name: 'Artur Potyrała',
  role: 'Senior Product Designer',
  email: 'artur@ptrl.design',
  // TODO: real profile URLs
  linkedin: 'https://www.linkedin.com/',
  dribbble: 'https://dribbble.com/',
};

/** Page sections, shared by the masthead Index and the sticky nav. */
export const sections: Line[] = [
  { text: 'Work', href: '#work' },
  { text: 'About', href: '#about' },
  { text: 'Contact', href: '#contact' },
];

export const masthead: Info[] = [
  { label: 'Portfolio', lines: [{ text: person.name }, { text: person.role }, { text: 'Kraków, PL' }] },
  {
    label: 'In short',
    lines: [{ text: 'A product designer with a passion for interfaces that seamlessly integrate form and function.' }],
  },
  { label: 'Index', lines: sections },
  {
    label: 'Contact',
    lines: [
      { text: person.email, href: `mailto:${person.email}` },
      { text: 'LinkedIn', href: person.linkedin, external: true },
      { text: 'Dribbble', href: person.dribbble, external: true },
    ],
  },
];

export const heroMeta = {
  coordinates: '50.06° N / 19.94° E',
  edition: 'Portfolio / Edition 2026',
  scroll: 'Scroll',
};

export const workHeader = {
  label: '01 / Work',
  title: 'Selected work', // the orange full stop is added by the component
  intro: 'Product work across fintech, web3, e-commerce, social media and submarine search and rescue.',
};

export const about = {
  label: '02 / About',
  statement:
    "Hi! I'm Artur, a senior product designer based in Kraków, Poland. For over five years I've designed interfaces that seamlessly integrate form and function.",
  portrait: null as null | { src: string; alt: string },
  facts: [
    { label: 'Background', lines: [{ text: 'Degree in Graphic Design. Postgraduate studies in UX and Product Design at SWPS University.' }] },
    { label: 'Domains', lines: [{ text: 'Submarine search and rescue, e-commerce, fintech, web3 and social media.' }] },
    { label: 'Off-screen', lines: [{ text: 'Electric skateboards, analogue photography, 3D printing and alternative coffee brewing.' }] },
    { label: 'Previously with', lines: [{ text: 'NATO, UNICEF, BASF, United Nations, Supermojo, Best Egg.' }] },
  ] as Info[],
};

export const contact = {
  label: '03 / Contact',
  title: "Let's talk",
  details: [
    { label: 'Email', lines: [{ text: person.email, href: `mailto:${person.email}` }] },
    {
      label: 'Social',
      lines: [
        { text: 'LinkedIn', href: person.linkedin, external: true },
        { text: 'Dribbble', href: person.dribbble, external: true },
      ],
    },
    { label: 'Based in', lines: [{ text: 'Kraków, Poland' }, { text: '50.06° N, 19.94° E' }] },
  ] as Info[],
  colophon: ['© 2026 Artur Potyrała', 'V2.0', 'Updated Sep 2026'],
};
