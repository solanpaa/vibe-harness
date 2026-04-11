import { defineConfig } from "nitro";

export default defineConfig({
  modules: ["workflow/nitro"],
  features: {
    websocket: true,
  },
  routes: {
    "/ws": "./src/ws/run-stream.ts",
    "/**": "./src/index.ts",
  },
});
