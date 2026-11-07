/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0a0b", 900: "#121214", 800: "#1a1a1e", 700: "#26262c", 600: "#36363e" },
        accent: { DEFAULT: "#d9894f", dim: "#a8693c", soft: "#e3a57a" },
        ok: "#5fb58a",
        warn: "#d6a548",
        bad: "#e06c66",
        doordash: "#e0705e",
        ubereats: "#5fb58a",
      },
      fontFamily: {
        display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        pulseRing: { "0%,100%": { opacity: "0.35" }, "50%": { opacity: "1" } },
        wave: { "0%,100%": { transform: "scaleY(0.3)" }, "50%": { transform: "scaleY(1)" } },
        firePulse: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.8" } },
        slideIn: { from: { opacity: "0", transform: "translateY(-2px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        fireBorder: {
          "0%,100%": { borderColor: "rgba(217,137,79,0.25)" },
          "50%": { borderColor: "rgba(217,137,79,0.5)" },
        },
        speakGlow: { "0%,100%": { backgroundColor: "rgba(217,137,79,0.12)" }, "50%": { backgroundColor: "rgba(217,137,79,0.22)" } },
      },
      animation: {
        pulseRing: "pulseRing 1.6s ease-in-out infinite",
        wave: "wave 0.9s ease-in-out infinite",
        firePulse: "firePulse 2.4s ease-in-out infinite",
        slideIn: "slideIn 0.25s ease-out",
        fireBorder: "fireBorder 2.8s ease-in-out infinite",
        speakGlow: "speakGlow 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
