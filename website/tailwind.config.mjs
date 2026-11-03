/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        eggshell: '#fdfcfc',
        taupe: '#f5f3f1',
        stone: '#e7e5e4',
        ash: '#a8a29e',
        smoke: '#78716c',
        graphite: '#44403c',
        ink: '#1c1917',
      },
      fontFamily: {
        serif: ['"Instrument Serif"', 'serif'],
        sans: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
