import type { NextConfig } from 'next';

const nextConfig: NextConfig = process.env.MOBIUP_RUNTIME === 'node' ? {output:'standalone'} : {};

export default nextConfig;
