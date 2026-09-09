import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-side API routes are required (/api/state, /api/plan), so no static export.
  reactStrictMode: true,
};

export default nextConfig;
