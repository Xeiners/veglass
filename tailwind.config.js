/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Full 0–100 opacity scale so `/6`, `/12`, `/55` … are all valid
      // modifiers; the design leans on many low-alpha hairlines.
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [String(i), String(i / 100)]),
      ),
      colors: {
        // Deep slate canvas — near-black, never pure black.
        ink: {
          950: '#08090B',
          900: '#0D0F12',
          850: '#101216',
          800: '#14171C',
          750: '#181C22',
          700: '#1E232B',
          600: '#272D37',
          500: '#333A46',
        },
        // Single accent, walked along the indigo → violet gradient.
        // 400/500/600/700 are taken verbatim from the source gradient.
        accent: {
          100: '#EDE9FE',
          200: '#DDD6FE',
          300: '#A78BFA',
          400: '#7C3AED',
          500: '#4F46E5',
          600: '#4338CA',
          700: '#312E81',
          DEFAULT: '#4F46E5',
        },
        // Audio material. Warm gold, opposite the accent on the wheel, so a
        // sound layer is never mistaken for a picture layer on the timeline.
        wave: {
          100: '#FEF3C7',
          200: '#FDE68A',
          300: '#FCD34D',
          400: '#FBBF24',
          500: '#F59E0B',
          600: '#D97706',
          DEFAULT: '#FBBF24',
        },
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI Variable Text',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Cascadia Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.01em' }],
      },
      letterSpacing: {
        tightest: '-0.035em',
      },
      borderRadius: {
        '4xl': '1.75rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,.32), 0 8px 24px -12px rgba(0,0,0,.7)',
        lift: '0 24px 60px -24px rgba(0,0,0,.85), 0 2px 8px rgba(0,0,0,.4)',
        glow: '0 0 0 1px rgba(124,58,237,.30), 0 8px 32px -10px rgba(124,58,237,.55)',
        inset: 'inset 0 1px 0 rgba(255,255,255,.055)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '48px 48px',
      },
      transitionTimingFunction: {
        smooth: 'cubic-bezier(.22,.61,.36,1)',
        spring: 'cubic-bezier(.34,1.56,.64,1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'scale-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(124,58,237,.35)' },
          '70%': { boxShadow: '0 0 0 10px rgba(124,58,237,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(124,58,237,0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in .28s cubic-bezier(.22,.61,.36,1) both',
        'scale-in': 'scale-in .26s cubic-bezier(.22,.61,.36,1) both',
        'slide-up': 'slide-up .34s cubic-bezier(.22,.61,.36,1) both',
        shimmer: 'shimmer 1.8s infinite',
        'pulse-ring': 'pulse-ring 2s cubic-bezier(.22,.61,.36,1) infinite',
      },
    },
  },
  plugins: [],
};
