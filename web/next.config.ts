import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Racine Turbopack explicite (évite un warning de détection hors repo).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
