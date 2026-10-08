import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { UserProfile, UserRecord } from '@hearth/shared';
import { userOperations } from '../users/operations.js';
import { userHandler } from './handlers.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const SUB = 'u-1';

function event(routeKey: string, claims: Record<string, unknown> | undefined, opts: { id?: string; body?: string } = {}) {
  return {
    routeKey,
    pathParameters: opts.id ? { id: opts.id } : undefined,
    body: opts.body,
    isBase64Encoded: false,
    requestContext: { authorizer: claims ? { jwt: { claims, scopes: null } } : undefined },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/** A Users table holding whoever has signed in, with the store's rules for a first sign-in. */
function fakeUsers(existing: Partial<UserRecord>[] = []) {
  const users = new Map(existing.map((u) => [u.userId!, u as UserRecord]));
  return {
    users,
    store: {
      recordSignIn: async (userId: string, profile: UserProfile, at: Date): Promise<UserRecord> => {
        const prior = users.get(userId);
        const record: UserRecord = {
          approved: false,
          serverLimit: 3,
          createdAt: at.toISOString(),
          ...prior,
          ...profile,
          userId,
          lastSeenAt: at.toISOString(),
        };
        users.set(userId, record);
        return record;
      },
      getUser: async (userId: string) => users.get(userId),
      setApproved: async (userId: string, approved: boolean, at: Date) => {
        const user = users.get(userId);
        if (!user) return false;
        users.set(userId, { ...user, approved, ...(approved ? { approvedAt: at.toISOString() } : {}) });
        return true;
      },
    },
  };
}

const googleClaims = {
  sub: SUB,
  token_use: 'id',
  'cognito:username': 'Google_1',
  email: 'tarik@example.com',
  name: 'Tarik',
};

describe('user routes', () => {
  describe('GET /v1/me', () => {
    it('records a first-time user, not yet approved, and logs them as new', async () => {
      const { store, users } = fakeUsers();
      const logs: Record<string, unknown>[] = [];
      const res = await userHandler({ users: store, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: (e) => logs.push(e) })(event('GET /v1/me', googleClaims));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        userId: SUB,
        admin: false,
        approved: false,
        serverLimit: 3,
        createdAt: '2026-10-08T12:00:00.000Z',
        provider: 'Google',
        email: 'tarik@example.com',
        name: 'Tarik',
      });
      expect(users.get(SUB)?.approved).toBe(false);
      expect(logs).toEqual([{ msg: 'new user', userId: SUB, provider: 'Google' }]);
    });

    it("keeps a returning user's approval and limit, refreshing their profile", async () => {
      const { store } = fakeUsers([{ userId: SUB, approved: true, serverLimit: 5, createdAt: '2026-10-01T00:00:00.000Z', name: 'Old name' }]);
      const res = await userHandler({ users: store, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(event('GET /v1/me', googleClaims));
      expect(JSON.parse(res.body!)).toMatchObject({ approved: true, serverLimit: 5, name: 'Tarik', createdAt: '2026-10-01T00:00:00.000Z' });
    });

    it('says whether the caller is an admin, from their groups', async () => {
      const { store } = fakeUsers();
      const res = await userHandler({ users: store, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(
        event('GET /v1/me', { ...googleClaims, 'cognito:groups': '[admin]' }),
      );
      expect(JSON.parse(res.body!).admin).toBe(true);
    });
  });

  it('answers 401 to an access token, or no claims at all', async () => {
    const { store } = fakeUsers();
    const handle = userHandler({ users: store, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} });
    expect((await handle(event('GET /v1/me', { ...googleClaims, token_use: 'access' }))).statusCode).toBe(401);
    expect((await handle(event('GET /v1/me', undefined))).statusCode).toBe(401);
  });

  describe('POST /v1/admin/users/{id}/approval', () => {
    const ROUTE = 'POST /v1/admin/users/{id}/approval';
    const admin = { ...googleClaims, 'cognito:groups': '[admin]' };
    const setup = () => {
      const { store, users } = fakeUsers([{ userId: 'friend', approved: false, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then' }]);
      const logs: Record<string, unknown>[] = [];
      const handle = userHandler({
        users: store,
        userOps: userOperations({ users: store, now: () => NOW }),
        now: () => NOW,
        log: (e) => logs.push(e),
      });
      return { handle, users, logs };
    };

    it('lets an admin approve a user, answering with their record and logging who did it', async () => {
      const { handle, users, logs } = setup();
      const res = await handle(event(ROUTE, admin, { id: 'friend', body: '{"approved":true}' }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ userId: 'friend', approved: true, approvedAt: '2026-10-08T12:00:00.000Z' });
      expect(users.get('friend')?.approved).toBe(true);
      expect(logs).toEqual([{ msg: 'user approval set', by: SUB, userId: 'friend', approved: true }]);
    });

    it('takes approval back', async () => {
      const { handle, users } = setup();
      await handle(event(ROUTE, admin, { id: 'friend', body: '{"approved":true}' }));
      await handle(event(ROUTE, admin, { id: 'friend', body: '{"approved":false}' }));
      expect(users.get('friend')?.approved).toBe(false);
    });

    it('refuses everyone outside the admin group with 403, changing nothing', async () => {
      const { handle, users } = setup();
      const res = await handle(event(ROUTE, googleClaims, { id: 'friend', body: '{"approved":true}' }));
      expect(res.statusCode).toBe(403);
      expect(users.get('friend')?.approved).toBe(false);
    });

    it('answers 404 for someone who has never signed in, and 400 for a bad body', async () => {
      const { handle } = setup();
      expect((await handle(event(ROUTE, admin, { id: 'stranger', body: '{"approved":true}' }))).statusCode).toBe(404);
      expect((await handle(event(ROUTE, admin, { id: 'friend', body: '{"approved":"yes"}' }))).statusCode).toBe(400);
      expect((await handle(event(ROUTE, admin, { id: 'friend', body: 'nope' }))).statusCode).toBe(400);
    });
  });

  it('answers 404 for a route it does not serve', async () => {
    const { store } = fakeUsers();
    const res = await userHandler({ users: store, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(event('GET /v1/nope', googleClaims));
    expect(res.statusCode).toBe(404);
  });
});
