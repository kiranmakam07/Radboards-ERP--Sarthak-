'use client';

import { createContext, useContext } from 'react';

export type Session = {
  user: { id: string; name: string; role: string; phone: string };
  permissions: string[];
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession used outside the signed-in area');
  return s;
}

/** UI hint only - the API enforces every permission itself. */
export function useCan() {
  const { permissions } = useSession();
  return (permission: string) => permissions.includes(permission);
}
