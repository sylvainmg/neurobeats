import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Racine Turbopack explicite (évite un warning de détection hors repo).
  turbopack: {
    root: __dirname,
  },
  images: {
    // Jaquettes des résultats de recherche (seul domaine distant utilisé).
    remotePatterns: [
      { protocol: "https", hostname: "i.ytimg.com", pathname: "/vi/**" },
    ],
  },
};

export default nextConfig;
