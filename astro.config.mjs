// @ts-check
import { defineConfig } from 'astro/config';

/** Spray intro tuning bench at /dev/spray: `astro dev` only, never in a build. */
const sprayBench = {
  name: 'spray-bench',
  hooks: {
    /** @param {{ command: string, injectRoute: (route: { pattern: string, entrypoint: string }) => void }} opts */
    'astro:config:setup': ({ command, injectRoute }) => {
      if (command === 'dev') injectRoute({ pattern: '/dev/spray', entrypoint: './src/dev/spray-bench.astro' });
    },
  },
};

export default defineConfig({
  // GitHub Pages (.github/workflows/deploy.yml) builds for its own address and subpath
  site: process.env.SITE_URL ?? 'https://ptrl.design',
  base: process.env.BASE_PATH ?? '/',
  // One page, ~20 KB of CSS: inlining it removes the only render-blocking request.
  build: { inlineStylesheets: 'always' },
  integrations: [sprayBench],
  // The spray intro chunk (three.js, loaded after first paint, only when WebGL runs) is ~645 KB raw / 179 KB gzipped
  vite: { build: { chunkSizeWarningLimit: 700 } },
});
