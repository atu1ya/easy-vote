/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
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