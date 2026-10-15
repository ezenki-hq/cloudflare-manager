import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { environment: "node", restoreMocks: true },
  build: { outDir: "dist", emptyOutDir: true },
});
