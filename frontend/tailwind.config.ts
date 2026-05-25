import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#f0f4ff",
          500: "#4f6ef7",
          600: "#3a56e8",
          700: "#2c44d0",
        },
      },
    },
  },
  plugins: [],
};

export default config;
