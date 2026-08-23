import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Built so a production stack trace is readable. deploy.sh excludes *.map
    // from the public root, so the maps stay in dist/ for local symbolication
    // without publishing the source. Without this, lastError from a real viewer
    // is minified noise.
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          hls: ["hls.js"],
          shaka: ["shaka-player"],
          react: ["react", "react-dom"]
        }
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    exclude: ["node_modules", "dist", "e2e"]
  }
});
