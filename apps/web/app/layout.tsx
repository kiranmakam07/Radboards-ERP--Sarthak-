import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'RadCore',
  description: 'Radboards ERP',
  icons: { apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'RadCore', statusBarStyle: 'black-translucent' },
};

// Runs before the screens load: the browser offers its install prompt once, early, and the
// "Install app" button (components/install.tsx) may not be on screen yet to catch it.
const INSTALL_SCRIPT = `
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__installPrompt = e;
  window.dispatchEvent(new Event('radcore:installable'));
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
}`;
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#141b26' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: INSTALL_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
