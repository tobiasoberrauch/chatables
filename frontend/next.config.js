/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /** Proxy API calls to the backend service during development. */
  async rewrites() {
    const apiTarget = process.env.API_BASE_URL || 'http://localhost:4000';
    const wsTarget = process.env.WS_BASE_URL || 'http://localhost:4001';

    return [
      {
        source: '/api/:path*',
        destination: `${apiTarget}/api/:path*`,
      },
      {
        source: '/ws/:path*',
        destination: `${wsTarget}/ws/:path*`,
      },
    ];
  },

  /** Allow images from common financial data CDNs. */
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.tradingview.com' },
      { protocol: 'https', hostname: '**.polygon.io' },
      { protocol: 'https', hostname: 'flagcdn.com' },
    ],
  },

  /** Transpile the shared types package when imported directly. */
  transpilePackages: ['@chatables/shared'],
};

module.exports = nextConfig;
