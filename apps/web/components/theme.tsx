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
  const flip = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('radcore-theme', next); } catch { /* private window: works for this visit only */ }
    setTheme(next);
  };
  return (
    <button type="button" role="menuitem" onClick={flip}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />{theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
