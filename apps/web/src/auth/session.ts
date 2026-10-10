// Signing in to Hearth from the browser, as the CLI does (cli/src/auth.ts): the managed login
// pages, a code back at /auth/callback, exchanged with PKCE for tokens. The session (the ID token
// the API takes, and a refresh token: 7 days) lives in this browser's storage; the strict content
// policy (FrontendStack) is what keeps other scripts from reading it.
import type { WebConfig } from '@hearth/shared';

export interface Session {
  idToken: string;
  refreshToken: string;
}

/** A sign-in under way: what the callback checks and needs (kept for this tab only). */
export interface PendingSignIn {
  state: string;
  verifier: string;
  /** Where to go once signed in. */
  returnTo: string;
}

/** Where the session and a pending sign-in are kept. Storage can be missing or blocked: reads
 *  then find nothing and writes do nothing (the person signs in again). */
export interface Stores {
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  pending: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

const SESSION_KEY = 'hearth.session';
const PENDING_KEY = 'hearth.signin';

function read<T>(store: Stores['session'], key: string): T | undefined {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(store: Stores['session'], key: string, value: unknown): void {
  try {
    if (value === undefined) store?.removeItem(key);
    else store?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (a private window, site data off): the session lasts until the tab closes.
  }
}

export const readSession = (stores: Stores) => read<Session>(stores.session, SESSION_KEY);
export const writeSession = (stores: Stores, session: Session | undefined) => write(stores.session, SESSION_KEY, session);

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomString = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));

/** PKCE: the verifier stays here, the challenge (its SHA-256) goes to the login page. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The sign-in callback for this page's origin. */
export const callbackUrl = (origin: string) => `${origin}/auth/callback`;

/**
 * Starts signing in: remembers a fresh state and verifier for this tab, and returns the login
 * page's address. `provider` (Google, Discord) skips the page's choice.
 */
export async function beginSignIn(
  config: WebConfig,
  stores: Stores,
  { origin, returnTo, provider }: { origin: string; returnTo: string; provider?: string },
): Promise<string> {
  const pending: PendingSignIn = { state: randomString(), verifier: randomString(), returnTo };
  write(stores.pending, PENDING_KEY, pending);
  const query = new URLSearchParams({
    client_id: config.auth.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: callbackUrl(origin),
    state: pending.state,
    code_challenge: await challengeFor(pending.verifier),
    code_challenge_method: 'S256',
    ...(provider ? { identity_provider: provider } : {}),
  });
  return `${config.auth.domain}/oauth2/authorize?${query}`;
}

/** Why a sign-in couldn't finish, in words for the person. */
export class SignInFailed extends Error {}

interface Tokens {
  id_token: string;
  refresh_token?: string;
}

async function tokenRequest(config: WebConfig, form: Record<string, string>, doFetch: typeof fetch): Promise<Tokens> {
  const res = await doFetch(`${config.auth.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.auth.clientId, ...form }).toString(),
  });
  if (!res.ok) throw new SignInFailed(`Sign-in was refused (${res.status}). Please try again.`);
  return (await res.json()) as Tokens;
}

/**
 * Finishes signing in at /auth/callback: checks the state against this tab's pending sign-in,
 * exchanges the code, keeps the session. Returns where to go next.
 */
export async function completeSignIn(
  config: WebConfig,
  stores: Stores,
  { origin, query, fetch: doFetch = fetch }: { origin: string; query: URLSearchParams; fetch?: typeof fetch },
): Promise<string> {
  const pending = read<PendingSignIn>(stores.pending, PENDING_KEY);
  write(stores.pending, PENDING_KEY, undefined);
  const error = query.get('error');
  if (error) {
    throw new SignInFailed(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in didn't work (${query.get('error_description') ?? error}).`);
  }
  if (!pending || query.get('state') !== pending.state) {
    throw new SignInFailed('This sign-in link was not started here, or has already been used. Please sign in again.');
  }
  const code = query.get('code');
  if (!code) throw new SignInFailed('Sign-in came back without a code. Please try again.');
  const tokens = await tokenRequest(
    config,
    { grant_type: 'authorization_code', code, redirect_uri: callbackUrl(origin), code_verifier: pending.verifier },
    doFetch,
  );
  if (!tokens.refresh_token) throw new SignInFailed('Sign-in came back incomplete. Please try again.');
  writeSession(stores, { idToken: tokens.id_token, refreshToken: tokens.refresh_token });
  return pending.returnTo;
}

/** A JWT's claims (not verified: the API does that; this only reads expiry and profile). */
export function readClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** An ID token with a minute to spare, refreshed (and kept) when it's nearly out; undefined when
 *  there's no session or it can't be refreshed (the session is then forgotten). */
export async function currentIdToken(
  config: WebConfig,
  stores: Stores,
  { now = Date.now(), force = false, fetch: doFetch = fetch }: { now?: number; force?: boolean; fetch?: typeof fetch } = {},
): Promise<string | undefined> {
  const session = readSession(stores);
  if (!session) return undefined;
  const exp = Number(readClaims(session.idToken).exp ?? 0) * 1000;
  if (!force && exp > now + 60_000) return session.idToken;
  try {
    // Cognito returns no new refresh token: the old one stays.
    const tokens = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: session.refreshToken }, doFetch);
    writeSession(stores, { idToken: tokens.id_token, refreshToken: session.refreshToken });
    return tokens.id_token;
  } catch {
    writeSession(stores, undefined);
    return undefined;
  }
}

/** Signs out here (forgets the session) and returns the managed login's sign-out address, which
 *  ends the Cognito session too and comes back to the site. */
export function signOut(config: WebConfig, stores: Stores, origin: string): string {
  writeSession(stores, undefined);
  const query = new URLSearchParams({ client_id: config.auth.clientId, logout_uri: origin });
  return `${config.auth.domain}/logout?${query}`;
}
