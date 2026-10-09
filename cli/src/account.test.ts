import { describe, expect, it } from 'vitest';
import type { MeResponse } from '@hearth/shared';
import { accountCommands, type AccountDeps } from './account.js';
import type { AdminGroup, PoolUser } from './admins.js';
import type { Session } from './auth.js';
import type { Api } from './client.js';

const USER_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function jwt(claims: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

function setup(overrides: Partial<AccountDeps> = {}) {
  const lines: string[] = [];
  const saved: { session?: Session } = {};
  const calls: string[] = [];
  const pool: PoolUser[] = [{ username: 'Google_123', userId: USER_ID, email: 'friend@example.com' }];
  const group: AdminGroup = {
    findUser: async (userId) => pool.find((u) => u.userId === userId),
    add: async (username) => void calls.push(`add ${username}`),
    remove: async (username) => void calls.push(`remove ${username}`),
    list: async () => pool,
  };
  const me: MeResponse = {
    userId: USER_ID,
    admin: false,
    approved: false,
    serverLimit: 3,
    createdAt: '2026-10-01T00:00:00Z',
    provider: 'Google',
    email: 'friend@example.com',
    name: 'Friend',
  };
  const api: Api = {
    get: async <T>(path: string) => (calls.push(`GET ${path}`), me as T),
    post: async () => {
      throw new Error('not used');
    },
  };
  const run = accountCommands({
    env: 'dev',
    signIn: async () => ({ id_token: jwt({ sub: USER_ID, name: 'Friend' }), refresh_token: 'refresh' }),
    session: {
      write: async (session) => void (saved.session = session),
      remove: async () => saved.session !== undefined && delete saved.session,
    },
    api: async () => api,
    admins: async () => group,
    print: (line) => lines.push(line),
    ...overrides,
  });
  return { run, lines, saved, calls };
}

describe('account commands', () => {
  it('login saves the session and says who signed in', async () => {
    const { run, lines, saved } = setup();
    await run.login();
    expect(saved.session).toEqual({ idToken: expect.any(String), refreshToken: 'refresh' });
    expect(lines[0]).toMatch(/^Signed in to dev as Friend\./);
  });

  it('login refuses tokens without a refresh token', async () => {
    const { run, saved } = setup({ signIn: async () => ({ id_token: jwt({}) }) });
    await expect(run.login()).rejects.toThrow('no refresh token');
    expect(saved.session).toBeUndefined();
  });

  it('logout forgets the session', async () => {
    const { run, lines } = setup();
    await run.login();
    await run.logout();
    await run.logout();
    expect(lines.slice(1)).toEqual(['Signed out of dev on this machine.', 'Not signed in to dev.']);
  });

  it('whoami shows /v1/me', async () => {
    const { run, lines, calls } = setup();
    await run.whoami();
    expect(calls).toEqual(['GET /v1/me']);
    expect(lines).toEqual([
      'Friend <friend@example.com>',
      `  user ID   ${USER_ID}`,
      '  sign-in   Google',
      '  admin     no',
      '  approved  no (an admin approves you before you can create servers)',
      '  servers   up to 3',
    ]);
  });

  it("adds and removes admins by user ID, through their Cognito username", async () => {
    const { run, lines, calls } = setup();
    await run.adminAdd(USER_ID);
    await run.adminRemove(USER_ID);
    expect(calls).toEqual(['add Google_123', 'remove Google_123']);
    expect(lines[0]).toContain('friend@example.com is now an admin of dev');
    expect(lines[1]).toContain('friend@example.com is no longer an admin of dev');
  });

  it('refuses an unknown user ID', async () => {
    const { run, calls } = setup();
    await expect(run.adminAdd('nobody')).rejects.toThrow("No user nobody in dev's user pool");
    expect(calls).toEqual([]);
  });

  it('lists admins', async () => {
    const { run, lines } = setup();
    await run.adminList();
    expect(lines).toEqual([`${USER_ID}  friend@example.com`]);
  });
});
