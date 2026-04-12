import { defineConfig } from "nitro";

export default defineConfig({
  modules: ["workflow/nitro"],
  features: {
    websocket: true,
  },
  devServer: {
    port: 19423,
  },
  runtimeConfig: {
    port: 19423,
  },
  // Disable file watcher to prevent crashes on git commits
  watchOptions: {
    ignored: ["**/.git/**", "**/node_modules/**", "**/.workflow-data/**", "**/.output/**"],
  },
  routes: {
    "/ws": "./src/ws/run-stream.ts",
    "/**": "./src/index.ts",
  },
});
