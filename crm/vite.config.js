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
    // Sin precarga de dependencias de los trozos diferidos (jsPDF): Vite las
    // pediría en "/assets/…" (base "/"), pero se sirven en /crm/dist/assets/.
    // Los import() relativos ya resuelven bien desde dist/main.js.
    modulePreload: false,
    rollupOptions: {
      input: "src/main.js",
      output: {
        entryFileNames: "main.js",
        format: "es",
      },
    },
  },
});
