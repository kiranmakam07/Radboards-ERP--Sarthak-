'use client';

import { useState } from 'react';
import { Icon } from './icons';

/**
 * Light or dark, from the person's menu. The choice is kept in this browser (localStorage key
 * radcore-theme) and put on the page as data-theme; the script in app/layout.tsx reads it back
 * before the next page is drawn. Until someone chooses, the phone or computer's own setting is
 * followed. The colours themselves are the tokens at the top of app/globals.css.
 */
type Theme = 'light' | 'dark';

const current = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

export function ThemeButton() {
  // The menu this sits in only opens after a click, so the page is already in the browser here.
  const [theme, setTheme] = useState<Theme>(current);
  const dark = theme === 'dark';
  const flip = () => {
    const next: Theme = dark ? 'light' : 'dark';
    // Colours cross-fade for a moment instead of jumping (globals.css, .theme-fade).
    const root = document.documentElement;
    root.classList.add('theme-fade');
    window.setTimeout(() => root.classList.remove('theme-fade'), 400);
    root.dataset.theme = next;
    try { localStorage.setItem('radcore-theme', next); } catch { /* private window: works for this visit only */ }
    setTheme(next);
  };
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={dark} className="me-item" onClick={flip}>
      <span className="me-icon"><Icon name="moon" size={17} /></span>
      <span className="me-text">Dark mode<small>{dark ? 'On' : 'Off'}</small></span>
      <span className={dark ? 'switch on' : 'switch'} aria-hidden="true"><span /></span>
    </button>
  );
}
