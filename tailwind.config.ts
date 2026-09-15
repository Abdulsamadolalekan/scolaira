import type { Config } from 'tailwindcss';

/**
 * SCOLAIRA Tailwind configuration — M0 foundation.
 *
 * M0 intentionally defines ONLY the structural theme (spacing, fonts, breakpoints)
 * and reserves semantic color CSS variables defined in `app/globals.css`.
 *
 * We do NOT hard-code brand palette hex values here.
 * M1 (Design System Foundation) will populate the full token system
 * (emerald/gold/ivory/ink semantic tokens) in app/globals.css and extend this
 * config to map Tailwind utility names to those tokens.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Font family placeholder; M1 will set Inter with tabular-nums default.
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Reserved keys — populated in M1 via CSS variables.
      colors: {
        // Placeholder tokens; M1 will add semantic scale (forest/gold/ivory/ink) to CSS vars
        // and reference them via Tailwind theme functions.
      },
    },
  },
  plugins: [],
};

export default config;
