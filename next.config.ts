import type { NextConfig } from "next";
import path from "path";

// Resolve the workspace root by finding where `next` is installed.
// When run via npx, `next` is a sibling in node_modules/ one level above
// this package, so __dirname alone isn't sufficient.
function findWorkspaceRoot(): string {
  try {
    const nextPkgPath = require.resolve("next/package.json");
    // next/package.json is at <root>/node_modules/next/package.json
    return path.resolve(path.dirname(nextPkgPath), "../..");
  } catch {
    return __dirname;
  }
}

const nextConfig: NextConfig = {
  turbopack: {
    root: findWorkspaceRoot(),
  },
};

export default nextConfig;
