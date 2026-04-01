import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.env.TURBOPACK_ROOT || __dirname,
  },
};

export default nextConfig;
