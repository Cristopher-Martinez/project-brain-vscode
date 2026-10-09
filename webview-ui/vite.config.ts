import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/webview-ui",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Single bundle — no code splitting for VS Code webview
        // No assets/ prefix — brain-hq.ts references files at dist/webview-ui/ root
        entryFileNames: "index.js",
        chunkFileNames: "[name].js",
        assetFileNames: "index.[ext]",
      },
    },
  },
});
