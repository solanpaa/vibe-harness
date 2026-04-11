import { defineConfig } from "nitro";

export default defineConfig({
  modules: ["workflow/nitro"],
  routes: {
    "/ws": "./src/ws/run-stream.ts",
    "/**": "./src/index.ts",
  },
});
