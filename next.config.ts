import type { NextConfig } from "next";

// When installed via npx, this package is inside node_modules/.
// Turbopack needs the workspace root set to the npx wrapper root
// so it can resolve `next` and compile source files.
// The wrapper root is passed via env from bin/vibe-harness.mjs.
const turbopackRoot = process.env.TURBOPACK_ROOT || __dirname;

const nextConfig: NextConfig = {
  turbopack: {
    root: turbopackRoot,
  },
};

export default nextConfig;
