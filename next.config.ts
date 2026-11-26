import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  ...(process.env.MOBIUP_RUNTIME === 'node' ? {output:'standalone' as const, serverExternalPackages:['@openai/agents','@openai/agents-codex','@openai/agents-core','@openai/agents-openai','@openai/agents-realtime']} : {}),
  async headers() {
    return ['/sw.js','/manifest.webmanifest','/offline.html'].map(source=>({
      source,
      headers:[{key:'Cache-Control',value:'no-cache, max-age=0, must-revalidate'}],
    }));
  },
};

export default nextConfig;
