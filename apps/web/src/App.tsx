import { useEffect } from 'react';
import { Callback } from './app/Callback';
import { Home } from './app/Home';
import { Shell } from './app/Shell';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { Landing } from './landing/Landing';
import { navigate, usePath } from './router';

/** The app: the front door at `/`, the sign-in callback, and the signed-in pages under `/app`. */
export function App({ path }: { path?: string }) {
  return (
    <AuthProvider>
      <Routes path={path} />
    </AuthProvider>
  );
}

function Routes({ path: fixed }: { path?: string }) {
  const live = usePath();
  const path = fixed ?? live;
  if (path === '/auth/callback') return <Callback />;
  if (path === '/app' || path.startsWith('/app/')) return <SignedIn path={path}><Home /></SignedIn>;
  if (path !== '/') return <NotFound />;
  return <Landing />;
}

/** Pages for signed-in people: anyone else goes to the login page, and back here after. */
function SignedIn({ path, children }: { path: string; children: React.ReactNode }) {
  const { status, signIn } = useAuth();
  useEffect(() => {
    if (status === 'signed-out') void signIn({ returnTo: path });
  }, [status, signIn, path]);
  if (status === 'signed-in') return children;
  return (
    <Shell>
      <p className="quiet" aria-live="polite">{status === 'unavailable' ? "Hearth can't be reached right now. Please try again in a moment." : 'Loading…'}</p>
    </Shell>
  );
}

function NotFound() {
  useEffect(() => navigate('/', { replace: true }), []);
  return null;
}
