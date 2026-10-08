import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build propio del área cliente, separado del del CRM (crm/vite.config.js):
// sus dependencias, su salida (area-cliente/dist) y nombres fijos sin hash,
// como el CRM — Vercel no construye nada: dist/ se commitea.
// base absoluta: area-cliente.html se sirve en /area-cliente (cleanUrls) y
// los chunks que genere Vite tienen que resolverse desde ahí.
export default defineConfig({
  plugins: [react()],
  base: "/area-cliente/dist/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.jsx",
      output: {
        entryFileNames: "portal.js",
        chunkFileNames: "portal-[name].js",
        assetFileNames: "portal[extname]",
        format: "es",
      },
    },
  },
});
