import type { MetadataRoute } from 'next';

/** Lets a phone add RadCore to its home screen, where it then opens full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RadCore',
    short_name: 'RadCore',
    description: 'Radboards ERP',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#141b26',
    icons: [
      { src: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { src: '/icon-512.png', type: 'image/png', sizes: '512x512' },
      { src: '/icon-maskable-512.png', type: 'image/png', sizes: '512x512', purpose: 'maskable' },
    ],
  };
}
