'use client';

import { useEffect, useState } from 'react';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
declare global {
  interface Window { __installPrompt?: InstallPrompt | null }
}

/**
 * "Install app": puts RadCore on the phone's home screen or the computer's desktop, where it opens
 * in a window of its own. Chrome, Edge and Samsung Internet hand over a prompt we can show from a
 * button (caught early by the script in app/layout.tsx); Safari on an iPhone has no such prompt,
 * so there the button explains the two taps instead. Nothing is shown once it is installed.
 */
export function InstallButton({ className }: { className?: string }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [mode, setMode] = useState<'unknown' | 'installed' | 'ios' | 'other'>('unknown');
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
    const iphone = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    setMode(standalone ? 'installed' : iphone ? 'ios' : 'other');
    setPrompt(window.__installPrompt ?? null);
    const onReady = () => setPrompt(window.__installPrompt ?? null);
    const onInstalled = () => { setMode('installed'); setPrompt(null); };
    window.addEventListener('radcore:installable', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('radcore:installable', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (mode === 'installed' || mode === 'unknown') return null;
  if (prompt) {
    return (
      <button type="button" className={className} onClick={async () => {
        await prompt.prompt();
        await prompt.userChoice.catch(() => null);
        // A prompt can be shown once; the browser sends a new one if it was dismissed.
        window.__installPrompt = null;
        setPrompt(null);
      }}>
        <span aria-hidden="true">⤓</span> Install app
      </button>
    );
  }
  if (mode !== 'ios') return null;
  return (
    <>
      <button type="button" className={className} aria-expanded={help} onClick={() => setHelp(!help)}>
        <span aria-hidden="true">⤓</span> Install app
      </button>
      {help ? <p className="install-help">In Safari, tap the Share button, then “Add to Home Screen”.</p> : null}
    </>
  );
}
