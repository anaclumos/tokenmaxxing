import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects: () => [
    { source: "/leaderboard", destination: "/", permanent: true },
  ],
};

export default nextConfig;
