import type { WebConfig } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { beginSignIn, challengeFor, completeSignIn, currentIdToken, readClaims, readSession, signOut, writeSession, type Stores } from './session';

const config: WebConfig = {
  env: 'dev',
  apiUrl: 'https://api.example',
  auth: { region: 'us-west-2', domain: 'https://hearth-dev.auth.example', clientId: 'web-client' },
};
const ORIGIN = 'https://site.example';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}
const stores = (): Stores => ({ session: memory(), pending: memory() });

/** A JWT-shaped token; unsigned, as only the API checks signatures. */
const jwt = (claims: Record<string, unknown>) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.s`;

function tokenEndpoint(answer: { status?: number; body?: unknown }) {
  const calls: URLSearchParams[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe('https://hearth-dev.auth.example/oauth2/token');
    calls.push(new URLSearchParams(init.body as string));
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('signing in', () => {
  it('sends the login page a PKCE challenge, a state and the site callback', async () => {
    const s = stores();
    const url = new URL(await beginSignIn(config, s, { origin: ORIGIN, returnTo: '/app', provider: 'Google' }));
    expect(url.origin + url.pathname).toBe('https://hearth-dev.auth.example/oauth2/authorize');
    const pending = JSON.parse(s.pending!.getItem('hearth.signin')!) as { state: string; verifier: string };
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'web-client',
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: 'https://site.example/auth/callback',
      state: pending.state,
      code_challenge: await challengeFor(pending.verifier),
      code_challenge_method: 'S256',
      identity_provider: 'Google',
    });
  });

  it('makes the challenge as S256 says: SHA-256, base64url without padding', async () => {
    // Node: createHash('sha256').update(verifier).digest('base64url')
    expect(await challengeFor('dBjftJeZ4CVP-mJ0OeH3dPqFBEzF0dnsKeOuJ7QZ5wc')).toBe('7E1Tn62OR8zc6yeS99UlsYxFqJoyondYZcejThCOBvM');
  });

  it('exchanges the code with the verifier, keeps the session and returns where to go', async () => {
    const s = stores();
    const url = new URL(await beginSignIn(config, s, { origin: ORIGIN, returnTo: '/app/servers' }));
    const { calls, fetch } = tokenEndpoint({ body: { id_token: 'id-1', refresh_token: 'refresh-1' } });
    const query = new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state')! });
    expect(await completeSignIn(config, s, { origin: ORIGIN, query, fetch })).toBe('/app/servers');
    const form = calls[0]!;
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('the-code');
    expect(form.get('client_id')).toBe('web-client');
    expect(form.get('redirect_uri')).toBe('https://site.example/auth/callback');
    expect(await challengeFor(form.get('code_verifier')!)).toBe(url.searchParams.get('code_challenge'));
    expect(readSession(s)).toEqual({ idToken: 'id-1', refreshToken: 'refresh-1' });
  });

  it('refuses a callback it did not start, and a second use of the same one', async () => {
    const s = stores();
    const url = new URL(await beginSignIn(config, s, { origin: ORIGIN, returnTo: '/app' }));
    const { calls, fetch } = tokenEndpoint({ body: { id_token: 'id', refresh_token: 'r' } });
    const wrong = new URLSearchParams({ code: 'c', state: 'someone-else' });
    await expect(completeSignIn(config, s, { origin: ORIGIN, query: wrong, fetch })).rejects.toThrow(/not started here/);
    const right = new URLSearchParams({ code: 'c', state: url.searchParams.get('state')! });
    await expect(completeSignIn(config, s, { origin: ORIGIN, query: right, fetch })).rejects.toThrow(/already been used/);
    expect(calls).toHaveLength(0);
    expect(readSession(s)).toBeUndefined();
  });

  it('says so when the person cancels on the login page', async () => {
    const s = stores();
    await beginSignIn(config, s, { origin: ORIGIN, returnTo: '/app' });
    const query = new URLSearchParams({ error: 'access_denied' });
    await expect(completeSignIn(config, s, { origin: ORIGIN, query })).rejects.toThrow('Sign-in was cancelled.');
  });
});

describe('the session', () => {
  const NOW = 1_800_000_000_000;

  it('uses the ID token while it has more than a minute left', async () => {
    const s = stores();
    const token = jwt({ exp: NOW / 1000 + 120 });
    writeSession(s, { idToken: token, refreshToken: 'r' });
    const { calls, fetch } = tokenEndpoint({});
    expect(await currentIdToken(config, s, { now: NOW, fetch })).toBe(token);
    expect(calls).toHaveLength(0);
  });

  it('refreshes it near expiry (or when forced), keeping the refresh token', async () => {
    const s = stores();
    writeSession(s, { idToken: jwt({ exp: NOW / 1000 + 30 }), refreshToken: 'r' });
    const { calls, fetch } = tokenEndpoint({ body: { id_token: 'fresh' } });
    expect(await currentIdToken(config, s, { now: NOW, fetch })).toBe('fresh');
    expect(calls[0]!.get('grant_type')).toBe('refresh_token');
    expect(calls[0]!.get('refresh_token')).toBe('r');
    expect(readSession(s)).toEqual({ idToken: 'fresh', refreshToken: 'r' });
    expect(await currentIdToken(config, s, { now: NOW, force: true, fetch })).toBe('fresh');
    expect(calls).toHaveLength(2);
  });

  it('forgets a session that can no longer be refreshed', async () => {
    const s = stores();
    writeSession(s, { idToken: jwt({ exp: 1 }), refreshToken: 'expired' });
    const { fetch } = tokenEndpoint({ status: 400, body: { error: 'invalid_grant' } });
    expect(await currentIdToken(config, s, { now: NOW, fetch })).toBeUndefined();
    expect(readSession(s)).toBeUndefined();
  });

  it('works, signed out, when storage is blocked or missing', async () => {
    const fail = () => {
      throw new Error('blocked');
    };
    const blocked: Stores = { session: { getItem: fail, setItem: fail, removeItem: fail }, pending: undefined };
    writeSession(blocked, { idToken: 'x', refreshToken: 'y' });
    expect(readSession(blocked)).toBeUndefined();
    expect(await currentIdToken(config, blocked)).toBeUndefined();
  });

  it('reads claims, including non-ASCII names', () => {
    const claims = { exp: 5, name: 'Zoë' };
    const bytes = new TextEncoder().encode(JSON.stringify(claims));
    const token = `h.${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
    expect(readClaims(token)).toEqual(claims);
    expect(readClaims('not-a-jwt')).toEqual({});
  });

  it('signs out here and at the login pages, back to the site', () => {
    const s = stores();
    writeSession(s, { idToken: 'x', refreshToken: 'y' });
    const url = new URL(signOut(config, s, ORIGIN));
    expect(readSession(s)).toBeUndefined();
    expect(url.pathname).toBe('/logout');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'web-client', logout_uri: ORIGIN });
  });
});
