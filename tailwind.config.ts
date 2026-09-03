import type { Config } from 'tailwindcss';

/**
 * Colours are declared once, in app/globals.css, as space-separated RGB
 * triplets. Aliasing them here is what lets `text-muted`, `border-edge` and
 * `bg-panel/60` work with Tailwind alpha syntax instead of every component
 * spelling out `text-[rgb(var(--muted))]`.
 *
 * There is deliberately no hue in this map beyond `danger`. Adding one would
 * make it reachable from a utility class, which is exactly how the previous
 * palette leaked amber and red into fifteen components.
 */
export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        surface2: 'rgb(var(--surface-2) / <alpha-value>)',
        edge: 'rgb(var(--edge) / <alpha-value>)',
        edgeStrong: 'rgb(var(--edge-strong) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        muted2: 'rgb(var(--muted-2) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        onAccent: 'rgb(var(--on-accent) / <alpha-value>)',
        tint: 'rgb(var(--tint) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        // Red TEXT only. Fills, dots and borders take `danger`;
        // #EF4444 is too dark to read at the 9-11px sizes used here.
        dangerInk: 'rgb(var(--danger-ink) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      screens: {
        // `xs` is the phone-landscape / large-phone hinge. The defaults start
        // at sm=640, which is already past the point where the floating
        // panels have to become a sheet.
        xs: '480px',
      },
    },
  },
  plugins: [],
} satisfies Config;
