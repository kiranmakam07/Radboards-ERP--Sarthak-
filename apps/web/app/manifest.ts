import type { MetadataRoute } from 'next';

/** Lets a phone add RadCore to its home screen, where it then opens full-screen like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RadCore',
    short_name: 'RadCore',
    description: 'Radboards ERP',
    start_url: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#141b26',
    icons: [{ src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }],
  };
}
