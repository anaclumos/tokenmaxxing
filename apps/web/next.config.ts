import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects: () => [
    { source: "/dashboard", destination: "/app", permanent: true },
    { source: "/settings", destination: "/app/settings", permanent: false },
    { source: "/app/docs", destination: "/docs", permanent: false },
  ],
};

export default nextConfig;
