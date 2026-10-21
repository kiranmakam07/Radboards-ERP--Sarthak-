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

// Runs before anything is drawn, so a dark screen never flashes white first: the theme the person
// chose in their menu (components/theme.tsx), or else their phone or computer's own setting, which
// is then followed if it changes. globals.css holds the colours for each.
const THEME_SCRIPT = `
(function () {
  var root = document.documentElement, dark = window.matchMedia('(prefers-color-scheme: dark)');
  var chosen = function () { try { return localStorage.getItem('radcore-theme'); } catch (e) { return null; } };
  var apply = function () { var t = chosen(); root.dataset.theme = t === 'light' || t === 'dark' ? t : (dark.matches ? 'dark' : 'light'); };
  apply();
  dark.addEventListener('change', apply);
})();`;
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#141b26' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script sets data-theme on <html> before React takes over; React is told not to mind.
    // data-scroll-behavior: links within a page glide (globals.css), but Next.js jumps to the top of a new screen.
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <script dangerouslySetInnerHTML={{ __html: INSTALL_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
