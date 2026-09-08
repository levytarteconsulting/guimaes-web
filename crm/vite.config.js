import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// jsxRuntime "classic" replica exactamente el transform que hacía Babel
// Standalone en el navegador (React.createElement), sin cambiar el
// comportamiento en tiempo de ejecución.
export default defineConfig({
  plugins: [react({ jsxRuntime: "classic" })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.js",
      output: {
        entryFileNames: "main.js",
        format: "es",
      },
    },
  },
});
