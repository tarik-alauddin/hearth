import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { completeSignIn, SignInFailed } from '../auth/session';
import { navigate, safeReturnTo } from '../router';
import { Shell } from './Shell';

// The code can be exchanged once: StrictMode's second effect (and a re-render) share the first
// attempt instead of starting another.
let attempt: { search: string; result: Promise<string> } | undefined;

/** /auth/callback: the login page sends the browser back here with a code. */
export function Callback() {
  const { config, stores, signedIn, signIn } = useAuth();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!config) return;
    const search = window.location.search;
    if (attempt?.search !== search) {
      const query = new URLSearchParams(search);
      attempt = { search, result: completeSignIn(config, stores, { origin: window.location.origin, query }) };
    }
    attempt.result.then(
      (returnTo) => {
        signedIn();
        navigate(safeReturnTo(returnTo), { replace: true });
      },
      (err: unknown) => setError(err instanceof SignInFailed ? err.message : 'Sign-in could not finish. Please try again.'),
    );
  }, [config, stores, signedIn]);

  return (
    <Shell>
      <CallbackView error={error} onRetry={() => void signIn()} />
    </Shell>
  );
}

export function CallbackView({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (!error) return <p className="quiet" aria-live="polite">Signing you in…</p>;
  return (
    <div className="card" role="alert">
      <h1>Sign-in didn't finish</h1>
      <p>{error}</p>
      <div className="actions">
        <button className="btn btn-primary" type="button" onClick={onRetry}>Sign in again</button>
        <a className="btn" href="/">Back to the front page</a>
      </div>
    </div>
  );
}
