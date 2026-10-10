import type { WebConfig } from '@hearth/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiClient, type Api } from '../api';
import { loadConfig } from '../config';
import { beginSignIn, currentIdToken, readSession, signOut as endSession, type Stores } from './session';

export interface Auth {
  /** `loading` until config.json is read; `unavailable` when it can't be. */
  status: 'loading' | 'unavailable' | 'signed-out' | 'signed-in';
  config?: WebConfig;
  api?: Api;
  /** Goes to the login page; back at `returnTo` once signed in. */
  signIn(opts?: { returnTo?: string; provider?: string }): Promise<void>;
  signOut(): void;
  /** After /auth/callback kept a session. */
  signedIn(): void;
  stores: Stores;
}

const AuthContext = createContext<Auth | undefined>(undefined);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}

/** This browser's storage, or none (rendered without a browser, or storage blocked). */
function browserStores(): Stores {
  const get = (name: 'localStorage' | 'sessionStorage') => {
    try {
      return typeof window === 'undefined' ? undefined : window[name];
    } catch {
      return undefined;
    }
  };
  return { session: get('localStorage'), pending: get('sessionStorage') };
}

/** Reads the environment's config and keeps the sign-in state for the whole app. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<WebConfig>();
  const [status, setStatus] = useState<Auth['status']>('loading');
  const stores = useMemo(browserStores, []);

  useEffect(() => {
    loadConfig()
      .then((c) => {
        setConfig(c);
        setStatus(readSession(stores) ? 'signed-in' : 'signed-out');
      })
      .catch(() => setStatus('unavailable'));
  }, [stores]);

  // Another tab signing in or out changes this one too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'hearth.session' && config) setStatus(readSession(stores) ? 'signed-in' : 'signed-out');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [config, stores]);

  // One refresh at a time: several requests at once share it.
  const refreshing = useRef<Promise<string | undefined>>(undefined);
  const idToken = useCallback(
    (force: boolean) => {
      if (!config) return Promise.resolve(undefined);
      if (!force && refreshing.current) return refreshing.current;
      const next = currentIdToken(config, stores, { force }).finally(() => {
        if (refreshing.current === next) refreshing.current = undefined;
      });
      refreshing.current = next;
      return next;
    },
    [config, stores],
  );

  const auth = useMemo<Auth>(() => {
    const signedOut = () => setStatus('signed-out');
    return {
      status,
      config,
      stores,
      api: config ? apiClient({ config, idToken, signedOut }) : undefined,
      signIn: async ({ returnTo = '/app', provider } = {}) => {
        if (!config) return;
        window.location.assign(await beginSignIn(config, stores, { origin: window.location.origin, returnTo, provider }));
      },
      signOut: () => {
        if (!config) return;
        window.location.assign(endSession(config, stores, window.location.origin));
      },
      signedIn: () => setStatus('signed-in'),
    };
  }, [status, config, stores, idToken]);

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
