import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react-swc"
import tailwindcss from "@tailwindcss/vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        background: path.resolve(__dirname, "src/extension/background.ts"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Background service worker must be at the root as background.js
          if (chunkInfo.name === "background") return "background.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
})
