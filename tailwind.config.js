/** @type {import('tailwindcss').Config} */
export default {
  // Only the UI module carries class names. Scanning the counting, report and
  // PDF modules made Tailwind mistake regexes such as /[-:T]/ for arbitrary
  // property utilities and emit invalid CSS.
  content: ["./index.html", "./src/main.jsx"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Manrope", "Segoe UI", "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 24px 80px rgba(15, 23, 42, 0.12)",
      },
    },
  },
  plugins: [],
};