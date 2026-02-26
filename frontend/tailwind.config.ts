import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          /** Primary backgrounds — deepest to lightest */
          bg: '#0a0a0f',
          'bg-secondary': '#111116',
          'bg-tertiary': '#1a1a24',
          'bg-elevated': '#22222e',
          'bg-hover': '#2a2a38',

          /** Borders & dividers */
          border: '#2e2e3e',
          'border-light': '#3a3a4e',

          /** Text hierarchy */
          text: '#e8e8ed',
          'text-secondary': '#a0a0b0',
          'text-muted': '#6e6e82',
          'text-dim': '#4a4a5e',

          /** Accent — gain/loss (market convention) */
          gain: '#00c853',
          'gain-muted': '#00c85340',
          'gain-bg': '#00c85318',
          loss: '#ff1744',
          'loss-muted': '#ff174440',
          'loss-bg': '#ff174418',

          /** Functional accents */
          accent: '#448aff',
          'accent-muted': '#448aff40',
          'accent-bg': '#448aff18',
          warning: '#ffab00',
          'warning-bg': '#ffab0018',

          /** Sentiment badge colours */
          bullish: '#00c853',
          bearish: '#ff1744',
          neutral: '#78909c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Fira Code"', '"SF Mono"', 'Consolas', 'monospace'],
      },
      fontSize: {
        'xxs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
      },
      animation: {
        'pulse-fast': 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flash-green': 'flashGreen 0.6s ease-out',
        'flash-red': 'flashRed 0.6s ease-out',
      },
      keyframes: {
        flashGreen: {
          '0%': { backgroundColor: '#00c85330' },
          '100%': { backgroundColor: 'transparent' },
        },
        flashRed: {
          '0%': { backgroundColor: '#ff174430' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
