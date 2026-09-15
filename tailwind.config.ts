import type { Config } from 'tailwindcss';

/**
 * SCOLAIRA Tailwind configuration.
 *
 * Theme values are derived from CSS custom properties defined in
 * `app/tokens.css` so that components never hard-code hex values, spacing, or
 * radii. When the final brand system lands, change tokens.css only.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forest: {
          deepest: 'var(--color-forest-deepest)',
          deep: 'var(--color-forest-deep)',
          primary: 'var(--color-forest-primary)',
          accent: 'var(--color-forest-accent)',
          tint: 'var(--color-forest-tint)',
          wash: 'var(--color-forest-wash)',
        },
        gold: {
          rich: 'var(--color-gold-rich)',
          reference: 'var(--color-gold-reference)',
          tint: 'var(--color-gold-tint)',
        },
        ivory: 'var(--color-ivory)',
        ink: {
          deepest: 'var(--color-ink-deepest)',
          primary: 'var(--color-ink-primary)',
          secondary: 'var(--color-ink-secondary)',
          muted: 'var(--color-ink-muted)',
          subtle: 'var(--color-ink-subtle)',
          faint: 'var(--color-ink-faint)',
        },
        surface: {
          page: 'var(--color-bg-page)',
          base: 'var(--color-bg-surface)',
          subtle: 'var(--color-bg-subtle)',
          gold: 'var(--color-bg-gold)',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
          inverse: 'var(--color-text-inverse)',
        },
        border: {
          DEFAULT: 'var(--color-border)',
          strong: 'var(--color-border-strong)',
          focus: 'var(--color-border-focus)',
        },
        success: {
          fg: 'var(--color-success-fg)',
          bg: 'var(--color-success-bg)',
        },
        warning: {
          fg: 'var(--color-warning-fg)',
          bg: 'var(--color-warning-bg)',
        },
        danger: {
          fg: 'var(--color-danger-fg)',
          bg: 'var(--color-danger-bg)',
        },
        info: {
          fg: 'var(--color-info-fg)',
          bg: 'var(--color-info-bg)',
        },
        neutral: {
          fg: 'var(--color-neutral-fg)',
          bg: 'var(--color-neutral-bg)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '1.4', letterSpacing: '0.02em' }],
        xs: ['var(--text-xs-size)', { lineHeight: 'var(--text-xs-line)' }],
        sm: ['var(--text-sm-size)', { lineHeight: 'var(--text-sm-line)' }],
        base: ['var(--text-base-size)', { lineHeight: 'var(--text-base-line)' }],
        md: ['var(--text-md-size)', { lineHeight: 'var(--text-md-line)' }],
        lg: ['var(--text-lg-size)', { lineHeight: 'var(--text-lg-line)' }],
        xl: ['var(--text-xl-size)', { lineHeight: 'var(--text-xl-line)' }],
        '2xl': ['var(--text-2xl-size)', { lineHeight: 'var(--text-2xl-line)' }],
        '3xl': ['var(--text-3xl-size)', { lineHeight: 'var(--text-3xl-line)' }],
        '4xl': ['var(--text-4xl-size)', { lineHeight: 'var(--text-4xl-line)' }],
        '5xl': ['var(--text-5xl-size)', { lineHeight: 'var(--text-5xl-line)' }],
      },
      fontWeight: {
        normal: 'var(--font-normal)',
        medium: 'var(--font-medium)',
        semibold: 'var(--font-semibold)',
        bold: 'var(--font-bold)',
      },
      spacing: {
        0: 'var(--space-0)',
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        5: 'var(--space-5)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        10: 'var(--space-10)',
        12: 'var(--space-12)',
        16: 'var(--space-16)',
        20: 'var(--space-20)',
        sidebar: 'var(--sidebar-w)',
        'sidebar-collapsed': 'var(--sidebar-w-collapsed)',
        topbar: 'var(--topbar-h)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        'focus-ring': 'var(--border-focus-ring)',
        'focus-ring-danger': 'var(--border-danger-focus-ring)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--easing-standard)',
      },
      maxWidth: {
        content: 'var(--content-max)',
      },
      width: {
        sidebar: 'var(--sidebar-w)',
        'sidebar-collapsed': 'var(--sidebar-w-collapsed)',
      },
      height: {
        topbar: 'var(--topbar-h)',
      },
      // Responsive breakpoints: conservative to match modern SaaS defaults.
      // Screens preserved at Tailwind defaults (sm=640/md=768/lg=1024/xl=1280/2xl=1536).
    },
  },
  plugins: [],
};

export default config;
