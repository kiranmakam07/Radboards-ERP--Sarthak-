import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The shared package ships TypeScript source (money, GST and state-machine helpers).
  transpilePackages: ['@radcore/shared'],
  outputFileTracingRoot: root,
  turbopack: { root },
  // The browser only ever talks to this origin; /api is proxied to the Express API,
  // so the HttpOnly session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
