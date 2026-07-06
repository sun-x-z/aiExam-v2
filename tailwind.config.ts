import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#18161a",
        sand: "#f7f2ea",
        clay: "#b97a47",
        moss: "#1f5c4d",
        ember: "#b5472d",
      },
      boxShadow: {
        panel: "0 18px 60px rgba(24, 22, 26, 0.08)",
      },
      borderRadius: {
        xl2: "1.5rem",
      },
    },
  },
  plugins: [],
};

export default config;
