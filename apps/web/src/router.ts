import { useSyncExternalStore } from 'react';

// The app's few pages are routed in the browser (CloudFront answers every unknown path with
// index.html): the path is the state, and links push history entries. No router library needed yet.

const NAVIGATED = 'hearth:navigate';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

/** The current path (`/` when rendered without a browser). */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => '/');
}

/** Goes to a path inside the app; `replace` leaves no history entry (e.g. past the sign-in callback). */
export function navigate(to: string, { replace = false }: { replace?: boolean } = {}): void {
  if (replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.dispatchEvent(new Event(NAVIGATED));
}

/** Only paths inside the app (`/…`, not `//host`) are followed after signing in. */
export function safeReturnTo(path: string | null | undefined): string {
  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/app';
}
