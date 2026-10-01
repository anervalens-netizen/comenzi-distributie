import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.MOBIUP_RUNTIME === 'node' ? {output:'standalone' as const} : {}),
  async headers() {
    return ['/sw.js','/manifest.webmanifest','/offline.html'].map(source=>({
      source,
      headers:[{key:'Cache-Control',value:'no-cache, max-age=0, must-revalidate'}],
    }));
  },
};

export default nextConfig;
