import type { NextConfig } from "next";
import path from "path";

// When installed via npx, this package is at:
//   ~/.npm/_npx/.../node_modules/vibe-harness/
// Turbopack needs the root to be:
//   ~/.npm/_npx/.../
// so it can resolve `next` and compile our source files.
function findWorkspaceRoot(): string {
  const sep = path.sep;
  const nmSegment = sep + "node_modules" + sep;
  const idx = __dirname.lastIndexOf(nmSegment);
  if (idx !== -1) {
    return __dirname.substring(0, idx);
  }
  return __dirname;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: findWorkspaceRoot(),
  },
};

export default nextConfig;
