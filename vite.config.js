import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022", sourcemap: false, minify: true },
  server: { host: "0.0.0.0" },
});
