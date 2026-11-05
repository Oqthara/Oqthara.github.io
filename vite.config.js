import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The site is deployed to the organisation root (https://oqthara.github.io/), so `base` is
// "/". Assets and deep links are both root-relative.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The site is small and prerendered, so a single stylesheet and one script chunk keep
    // the deployed output easy to inspect.
    cssCodeSplit: false,
  },
});
