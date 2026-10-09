// Signing in to an environment's Cognito user pool, as scripts/lib/hearth-auth.ps1 does: the browser
// opens the managed login page, the callback is caught on localhost, and the code is exchanged
// with PKCE. The session (ID and refresh tokens) is kept in ~/.hearth/session-<env>.json.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/** The CLI client's callback (AuthStack registers it as the CLI client's only callback URL). */
export const CALLBACK_URL = 'http://localhost:8976/callback';

/** SSM `/hearth/<env>/auth`, written by AuthStack. */
export interface AuthConfig {
  region: string;
  userPoolId: string;
  issuer: string;
  domain: string; // https://hearth-<env>-<account>.auth.<region>.amazoncognito.com
  cliClientId: string;
}

/** What's kept between runs: the refresh token lasts 30 days, the ID token an hour. */
export interface Session {
  idToken: string;
  refreshToken: string;
}

export interface Tokens {
  id_token: string;
  refresh_token?: string;
}

export async function readAuthConfig(env: string, region: string): Promise<AuthConfig> {
  const out = await new SSMClient({ region }).send(new GetParameterCommand({ Name: `/hearth/${env}/auth` }));
  if (!out.Parameter?.Value) throw new Error(`No /hearth/${env}/auth parameter in ${region}: is the Auth stack deployed?`);
  return JSON.parse(out.Parameter.Value) as AuthConfig;
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** PKCE: the verifier stays here; the challenge goes to the login page; the state ties the callback to this sign-in. */
export function newPkce() {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()), state: base64Url(randomBytes(32)) };
}

export function authorizeUrl(config: AuthConfig, pkce: { challenge: string; state: string }, provider?: string): string {
  const query = new URLSearchParams({
    client_id: config.cliClientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: CALLBACK_URL,
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    ...(provider ? { identity_provider: provider } : {}),
  });
  return `${config.domain}/oauth2/authorize?${query}`;
}

/** A JWT's claims (not verified: the API does that; this only reads expiry and profile). */
export function readJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) throw new Error('Not a JWT');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Posts to the pool's token endpoint (a code exchange or a refresh). */
async function tokenRequest(config: AuthConfig, form: Record<string, string>, doFetch: typeof fetch): Promise<Tokens> {
  const res = await doFetch(`${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.cliClientId, ...form }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let reason = text;
    try {
      reason = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // not JSON
    }
    throw new Error(`Cognito refused the token request: ${reason || res.statusText}`);
  }
  return JSON.parse(text) as Tokens;
}

export function exchangeCode(config: AuthConfig, code: string, verifier: string, doFetch: typeof fetch = fetch) {
  return tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL, code_verifier: verifier }, doFetch);
}

/** New ID and access tokens (Cognito returns no new refresh token). */
export function refreshTokens(config: AuthConfig, refreshToken: string, doFetch: typeof fetch = fetch) {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, doFetch);
}

/**
 * Waits for the browser to come back to the callback, answering it with a page saying so, and
 * returns its query. Listens on 127.0.0.1 and ::1 (browsers may resolve localhost to either).
 */
export async function waitForCallback(url: string = CALLBACK_URL, timeoutMs = 5 * 60_000): Promise<URLSearchParams> {
  const { port, pathname } = new URL(url);
  const servers: Server[] = [];
  try {
    return await new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out after 5 minutes waiting for the browser to come back.')), timeoutMs);
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        const target = new URL(req.url ?? '/', 'http://localhost');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
        res.end('<!doctype html><title>Hearth</title><p style="font-family:sans-serif">Done. You can close this tab and go back to the terminal.</p>');
        if (target.pathname !== pathname) return; // e.g. the browser asking for /favicon.ico
        clearTimeout(timer);
        resolve(target.searchParams);
      };
      for (const host of ['127.0.0.1', '::1']) {
        const server = createServer(handler);
        servers.push(server);
        server.on('error', (err: NodeJS.ErrnoException) => {
          // No IPv6 on this machine is fine; the port being taken is not.
          if (host === '::1' && err.code !== 'EADDRINUSE') return;
          clearTimeout(timer);
          reject(new Error(`Could not listen on ${host}:${port} for the sign-in callback: ${err.message}`));
        });
        server.listen(Number(port), host);
      }
    });
  } finally {
    for (const server of servers) server.close();
  }
}

/** Opens a URL in the default browser (best effort: the URL is printed too). */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // no shell, so the URL's `&` survive
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** Signs in through the browser and returns the tokens. */
export async function signIn(
  config: AuthConfig,
  opts: { provider?: string; print: (line: string) => void; open?: (url: string) => void; callback?: () => Promise<URLSearchParams>; fetch?: typeof fetch },
): Promise<Tokens> {
  const pkce = newPkce();
  const url = authorizeUrl(config, pkce, opts.provider);
  const callback = (opts.callback ?? (() => waitForCallback()))(); // listening before the browser opens
  opts.print('Opening the sign-in page in your browser. If it does not open, go to:');
  opts.print(url);
  (opts.open ?? openBrowser)(url);
  const query = await callback;
  if (query.get('error')) throw new Error(`Sign-in failed: ${query.get('error')} ${query.get('error_description') ?? ''}`.trim());
  if (query.get('state') !== pkce.state) throw new Error('The callback came back with a different state: not this sign-in.');
  return exchangeCode(config, query.get('code') ?? '', pkce.verifier, opts.fetch);
}

/** The saved session for an environment, in ~/.hearth (readable by you only). */
export function sessionFile(env: string, home = homedir()) {
  const path = join(home, '.hearth', `session-${env}.json`);
  return {
    path,
    async read(): Promise<Session | undefined> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as Session;
      } catch {
        return undefined;
      }
    },
    async write(session: Session): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(session), { mode: 0o600 });
    },
    async remove(): Promise<boolean> {
      const had = (await this.read()) !== undefined;
      await rm(path, { force: true });
      return had;
    },
  };
}

/** Not signed in, or the session can't be refreshed: `hearth login` fixes it. */
export class SignInNeeded extends Error {}

/**
 * An ID token with a minute to spare: the saved one, or a refreshed one (saved). Never opens the
 * browser: only `hearth login` does.
 */
export async function currentIdToken(
  env: string,
  deps: { config: () => Promise<AuthConfig>; session: ReturnType<typeof sessionFile>; now?: () => Date; fetch?: typeof fetch },
): Promise<string> {
  const saved = await deps.session.read();
  if (!saved) throw new SignInNeeded(`Not signed in to ${env}: run hearth login --env ${env}`);
  const now = (deps.now?.() ?? new Date()).getTime() / 1000;
  if (Number(readJwt(saved.idToken).exp) > now + 60) return saved.idToken;
  let tokens: Tokens;
  try {
    tokens = await refreshTokens(await deps.config(), saved.refreshToken, deps.fetch);
  } catch {
    throw new SignInNeeded(`Your ${env} session has expired: run hearth login --env ${env}`);
  }
  await deps.session.write({ idToken: tokens.id_token, refreshToken: saved.refreshToken });
  return tokens.id_token;
}
