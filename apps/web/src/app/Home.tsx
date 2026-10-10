import { useEffect, useState } from 'react';
import type { MeResponse } from '@hearth/shared';
import { useAuth } from '../auth/AuthProvider';
import { Shell, displayName } from './Shell';

/** /app: the signed-in home. Servers arrive in M10 PR2; for now, who you are and whether you're approved. */
export function Home() {
  const { api, signOut } = useAuth();
  const [me, setMe] = useState<MeResponse>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!api) return;
    api.get<MeResponse>('/v1/me').then(setMe, (err: unknown) => setError(err instanceof Error ? err.message : 'Something went wrong.'));
  }, [api]);

  return (
    <Shell me={me} onSignOut={signOut}>
      {error ? (
        <div className="card" role="alert"><h1>Couldn't load your account</h1><p>{error}</p></div>
      ) : me ? (
        <HomeView me={me} />
      ) : (
        <p className="quiet" aria-live="polite">Loading…</p>
      )}
    </Shell>
  );
}

export function HomeView({ me }: { me: MeResponse }) {
  const waiting = !me.approved && !me.admin;
  return (
    <>
      <h1 className="page-title">{`Welcome, ${displayName(me)}`}</h1>
      {waiting && (
        <div className="card card-ember">
          <h2>Waiting for approval</h2>
          <p>You're signed in. Before you can start servers of your own, someone running Hearth needs to approve your account. You don't need to do anything else; this page will let you start one once you're approved.</p>
        </div>
      )}
      <section className="card">
        <h2>Your servers</h2>
        <p className="quiet">Your servers, and the ones friends have invited you to, will show here.</p>
      </section>
    </>
  );
}
