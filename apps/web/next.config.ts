import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  redirects: () => [
    { source: "/dashboard", destination: "/app", permanent: true },
    { source: "/settings", destination: "/app/settings", permanent: false },
    { source: "/docs", destination: "/app/docs", permanent: false },
  ],
};

export default nextConfig;
