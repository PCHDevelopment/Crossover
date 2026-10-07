import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API is on the same origin in production (the server serves this build). In development
// `vite` proxies it: run the server with DEV_LOGIN=true on :8080.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/app", emptyOutDir: true, sourcemap: true },
  server: {
    proxy: {
      "/v1": { target: "http://127.0.0.1:8080", changeOrigin: false, ws: true },
    },
  },
});
