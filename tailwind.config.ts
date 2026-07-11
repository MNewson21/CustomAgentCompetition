import type { Config } from "tailwindcss";

// The design system lives as CSS custom properties in app/globals.css (source of
// truth: design-tokens.json). Tailwind here only maps a thin set of semantic
// utilities onto those vars so components can reference `bg-surface`, `text-secondary`,
// etc. Never hard-code primitives in components — go through these semantic names.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--bg-canvas)",
        surface: "var(--bg-surface)",
        subtle: "var(--bg-subtle)",
        inset: "var(--bg-inset)",
        code: "var(--bg-code)",
        "border-default": "var(--border-default)",
        "border-strong": "var(--border-strong)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-tertiary": "var(--text-tertiary)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "status-pass": "var(--status-pass)",
        "status-fail": "var(--status-fail)",
        "status-running": "var(--status-running)",
        "status-live": "var(--status-live)",
      },
      fontFamily: {
        sans: "var(--font-sans)",
        mono: "var(--font-mono)",
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
      },
    },
  },
  plugins: [],
};

export default config;
