'use client';

import { createContext, useContext } from 'react';

export type Session = {
  user: { id: string; name: string; role: string; phone: string };
  permissions: string[];
  /** True on the demo and on a review copy: everything on screen is sample data. */
  sample_data?: boolean;
  /** The largest file that can be attached here, in MB. */
  max_upload_mb?: number;
  /** True when WhatsApp messages can be sent to a lead from inside the app. */
  whatsapp_send?: boolean;
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
