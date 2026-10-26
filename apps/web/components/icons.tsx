import type { ReactNode } from 'react';

/**
 * The few line icons the screens use, drawn here so that no icon library is needed. All are on a
 * 24-point grid with a 1.8 stroke in the current text colour, so they follow whatever they sit in.
 */
const PATHS: Record<string, ReactNode> = {
  home: <path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />,
  me: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>,
  store: <path d="M3 9l1.5-5h15L21 9M3 9h18M4 9v11h16V9M9 20v-6h6v6" />,
  crm: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-5.6 6.5-5.6s6.5 2 6.5 5.6" /><circle cx="17" cy="9" r="2.5" /><path d="M16.5 14.4c2.9.3 5 2 5 5.6" /></>,
  sales: <path d="M5 8h14l-1.2 13H6.2L5 8zM9 8V6.5a3 3 0 0 1 6 0V8" />,
  stores: <path d="M3 7.5l9-4.5 9 4.5v9l-9 4.5-9-4.5v-9zM3 7.5l9 4.5 9-4.5M12 12v9" />,
  accounts: <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zM5 17a3 3 0 0 1 3-3h11M9 8h6" />,
  hr: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="11" r="2.4" /><path d="M5.8 16.2c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3M14.5 10h4M14.5 13.5h4" /></>,
  operations: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4h6v3H9zM9 13l2 2 4-4" /></>,
  admin: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></>,
  bell: <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 20a2 2 0 0 0 4 0" />,
  down: <path d="M6 9l6 6 6-6" />,
  right: <path d="M9 6l6 6-6 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  board: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="10" rx="1.5" /><rect x="17" y="4" width="4" height="13" rx="1.5" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></>,
  chart: <path d="M5 20v-8M12 20V5M19 20v-5M3 20h18" />,
  rupee: <path d="M7 4h10M7 8h10M7 4c5 0 7 2 7 4s-2 4-7 4l7 8" />,
  trend: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" />,
  service: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3.5 17.3a1.8 1.8 0 0 0 2.5 2.5l5.8-5.8a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.4-.4-2.3 2.6-2.6z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14 9l2 2" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  install: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  dot: <circle cx="12" cy="12" r="2.2" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName | string; size?: number; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name] ?? PATHS.dot}
    </svg>
  );
}
