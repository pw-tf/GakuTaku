import { useEffect, type ReactNode } from 'react';
import { PowerSyncContext } from '@powersync/react';
import { useAuth } from '../auth/AuthProvider';
import { db, connectSync } from './system';

/**
 * Provides the PowerSync database to the React tree and (re)connects the sync
 * stream whenever the authenticated session changes. The connector's
 * fetchCredentials returns null while signed out, so connecting is a no-op then.
 */
export function SystemProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();

  useEffect(() => {
    if (!session) return;
    connectSync().catch((err) => console.error('PowerSync connect failed', err));
  }, [session?.user.id]);

  return <PowerSyncContext.Provider value={db}>{children}</PowerSyncContext.Provider>;
}
