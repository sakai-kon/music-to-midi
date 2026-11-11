import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.DEPLOY_BASE || "/",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false
  }
});
