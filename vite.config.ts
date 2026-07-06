import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Root-relative asset URLs keep JS/CSS loading from nested SPA routes.
  base: "/make-lrc/",
  build: {
    outDir: "make-lrc",
  },
  plugins: [react()],
});
