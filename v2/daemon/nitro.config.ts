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
  routes: {
    "/ws": "./src/ws/run-stream.ts",
    "/**": "./src/index.ts",
  },
});
