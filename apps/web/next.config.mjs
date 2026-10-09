import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
// On Vercel the API is part of this deployment (scripts/embed-api.mjs puts it behind /api),
// so there is no second server to pass requests on to.
const embedded = process.env.VERCEL === '1' || process.env.EMBED_API === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The shared package ships TypeScript source (money, GST and state-machine helpers).
  transpilePackages: ['@radcore/shared'],
  outputFileTracingRoot: root,
  turbopack: { root },
  // The embedded /api route lives in a `pages` folder, and with one present Next types its
  // navigation hooks as possibly null for every screen. They never are here (all screens are
  // in `app`), and `npm run typecheck` checks both programs without that folder, so the
  // build's own type check is skipped in this mode only.
  typescript: { ignoreBuildErrors: embedded },
  // The browser only ever talks to this origin; /api is proxied to the Express API,
  // so the HttpOnly session cookie stays first-party.
  async rewrites() {
    return embedded ? [] : [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
