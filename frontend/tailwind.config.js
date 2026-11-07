/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0a0a0b", 900: "#121214", 800: "#1a1a1e", 700: "#26262c", 600: "#36363e" },
        accent: { DEFAULT: "#ff7a1a", dim: "#c45a0e", soft: "#ff9a4d" },
        ok: "#2fd673",
        warn: "#ffb020",
        bad: "#ff4d4d",
        doordash: "#ff3008",
        ubereats: "#06c167",
      },
      fontFamily: {
        display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      keyframes: {
        pulseRing: { "0%,100%": { opacity: "0.35" }, "50%": { opacity: "1" } },
        wave: { "0%,100%": { transform: "scaleY(0.3)" }, "50%": { transform: "scaleY(1)" } },
        firePulse: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(255,122,26,0.55)" },
          "50%": { boxShadow: "0 0 0 10px rgba(255,122,26,0)" },
        },
        slideIn: { from: { opacity: "0", transform: "translateY(-6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        fireBorder: {
          "0%,100%": { borderColor: "rgba(255,122,26,0.35)", boxShadow: "0 0 0 0 rgba(255,122,26,0)" },
          "50%": { borderColor: "rgba(255,122,26,0.95)", boxShadow: "0 0 14px 0 rgba(255,122,26,0.35)" },
        },
        speakGlow: {
          "0%,100%": { boxShadow: "0 0 0 0 rgba(255,122,26,0.15)", backgroundColor: "rgba(255,122,26,0.2)" },
          "50%": { boxShadow: "0 0 18px 4px rgba(255,122,26,0.45)", backgroundColor: "rgba(255,122,26,0.35)" },
        },
      },
      animation: {
        pulseRing: "pulseRing 1.6s ease-in-out infinite",
        wave: "wave 0.9s ease-in-out infinite",
        firePulse: "firePulse 1.4s ease-out infinite",
        slideIn: "slideIn 0.25s ease-out",
        fireBorder: "fireBorder 1.6s ease-in-out infinite",
        speakGlow: "speakGlow 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
