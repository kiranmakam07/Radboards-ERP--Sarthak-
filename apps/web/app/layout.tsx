import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = { title: 'RadCore', description: 'Radboards ERP' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#141b26' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
