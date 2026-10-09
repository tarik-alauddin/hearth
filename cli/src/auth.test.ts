import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  CALLBACK_URL,
  currentIdToken,
  newPkce,
  readJwt,
  sessionFile,
  signIn,
  SignInNeeded,
  waitForCallback,
  type AuthConfig,
} from './auth.js';

const config: AuthConfig = {
  region: 'us-west-2',
  userPoolId: 'us-west-2_abc',
  issuer: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_abc',
  domain: 'https://hearth-dev-123.auth.us-west-2.amazoncognito.com',
  cliClientId: 'cli-client',
};

/** An unsigned JWT with these claims (only read here, never verified). */
function jwt(claims: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

const NOW = new Date('2026-10-08T12:00:00Z');
const epoch = (offsetSeconds: number) => NOW.getTime() / 1000 + offsetSeconds;

async function tempSession() {
  return sessionFile('dev', await mkdtemp(join(tmpdir(), 'hearth-home-')));
}

/** A token endpoint that records its requests and answers with `body` (or `status`). */
function tokenEndpoint(body: object, status = 200) {
  const requests: { url: string; form: URLSearchParams }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, form: new URLSearchParams(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('sign-in', () => {
  it('makes a PKCE challenge that is the S256 of its verifier', () => {
    const pkce = newPkce();
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    expect(pkce.state).not.toBe(newPkce().state);
  });

  it("builds the managed login URL for the CLI client, naming a provider when asked", () => {
    const url = new URL(authorizeUrl(config, { challenge: 'ch', state: 'st' }, 'Google'));
    expect(url.origin + url.pathname).toBe(`${config.domain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cli-client',
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: CALLBACK_URL,
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      identity_provider: 'Google',
    });
    expect(new URL(authorizeUrl(config, { challenge: 'ch', state: 'st' })).searchParams.has('identity_provider')).toBe(false);
  });

  it('exchanges the callback code with its verifier', async () => {
    const endpoint = tokenEndpoint({ id_token: 'id', refresh_token: 'refresh' });
    let opened = '';
    const tokens = await signIn(config, {
      print: () => {},
      open: (url) => (opened = url),
      // Listening starts before the browser opens; the browser comes back after.
      callback: async () => {
        await new Promise((r) => setImmediate(r));
        return new URLSearchParams({ code: 'the-code', state: new URL(opened).searchParams.get('state')! });
      },
      fetch: endpoint.fetch,
    });
    expect(tokens).toEqual({ id_token: 'id', refresh_token: 'refresh' });
    const [request] = endpoint.requests;
    expect(request?.url).toBe(`${config.domain}/oauth2/token`);
    expect(request?.form.get('grant_type')).toBe('authorization_code');
    expect(request?.form.get('code')).toBe('the-code');
    expect(request?.form.get('client_id')).toBe('cli-client');
    const challenge = new URL(opened).searchParams.get('code_challenge');
    expect(createHash('sha256').update(request!.form.get('code_verifier')!).digest('base64url')).toBe(challenge);
  });

  it("refuses a callback for another sign-in, or the page's error", async () => {
    const run = (query: Record<string, string>) =>
      signIn(config, { print: () => {}, open: () => {}, callback: async () => new URLSearchParams(query), fetch: tokenEndpoint({}).fetch });
    await expect(run({ code: 'c', state: 'someone-else' })).rejects.toThrow('different state');
    await expect(run({ error: 'access_denied', error_description: 'no' })).rejects.toThrow('Sign-in failed: access_denied no');
  });

  it('catches the browser coming back to the callback, ignoring other requests', async () => {
    const url = 'http://localhost:18976/callback';
    const waiting = waitForCallback(url, 5_000);
    await new Promise((r) => setTimeout(r, 100));
    expect((await fetch('http://127.0.0.1:18976/favicon.ico')).status).toBe(200);
    const page = await fetch('http://127.0.0.1:18976/callback?code=abc&state=xyz');
    expect(await page.text()).toContain('You can close this tab');
    expect(Object.fromEntries(await waiting)).toEqual({ code: 'abc', state: 'xyz' });
  });
});

describe('the saved session', () => {
  it('round-trips and forgets', async () => {
    const session = await tempSession();
    expect(await session.read()).toBeUndefined();
    await session.write({ idToken: 'i', refreshToken: 'r' });
    expect(await session.read()).toEqual({ idToken: 'i', refreshToken: 'r' });
    expect(await session.remove()).toBe(true);
    expect(await session.remove()).toBe(false);
  });

  it('uses a saved ID token with a minute to spare, without asking Cognito', async () => {
    const session = await tempSession();
    const idToken = jwt({ exp: epoch(120) });
    await session.write({ idToken, refreshToken: 'r' });
    const endpoint = tokenEndpoint({});
    expect(await currentIdToken('dev', { config: async () => config, session, now: () => NOW, fetch: endpoint.fetch })).toBe(idToken);
    expect(endpoint.requests).toHaveLength(0);
  });

  it('refreshes one about to expire, and keeps the refresh token', async () => {
    const session = await tempSession();
    await session.write({ idToken: jwt({ exp: epoch(30) }), refreshToken: 'r' });
    const fresh = jwt({ exp: epoch(3600) });
    const endpoint = tokenEndpoint({ id_token: fresh });
    expect(await currentIdToken('dev', { config: async () => config, session, now: () => NOW, fetch: endpoint.fetch })).toBe(fresh);
    expect(endpoint.requests[0]?.form.get('grant_type')).toBe('refresh_token');
    expect(endpoint.requests[0]?.form.get('refresh_token')).toBe('r');
    expect(await session.read()).toEqual({ idToken: fresh, refreshToken: 'r' });
  });

  it('asks for hearth login when there is no session, or it can no longer refresh', async () => {
    const session = await tempSession();
    const deps = { config: async () => config, session, now: () => NOW, fetch: tokenEndpoint({ error: 'invalid_grant' }, 400).fetch };
    await expect(currentIdToken('dev', deps)).rejects.toThrow(new SignInNeeded('Not signed in to dev: run hearth login --env dev'));
    await session.write({ idToken: jwt({ exp: epoch(-10) }), refreshToken: 'r' });
    await expect(currentIdToken('dev', deps)).rejects.toThrow('Your dev session has expired: run hearth login --env dev');
  });

  it('reads JWT claims', () => {
    expect(readJwt(jwt({ sub: 'u-1', exp: 5 }))).toEqual({ sub: 'u-1', exp: 5 });
  });
});
