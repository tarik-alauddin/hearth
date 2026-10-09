import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { ServerRecord, UserProfile, UserRecord } from '@hearth/shared';
import { userOperations } from '../users/operations.js';
import { AccessDenied } from '../authz.js';
import { OperationError } from '../servers/operations.js';
import { userHandler, type UserHandlerDeps } from './handlers.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const SUB = 'u-1';

/** Operations for tests that don't reach them: any call fails. */
function notUsed<T>(): T {
  return new Proxy(
    {},
    {
      get: (_, name) => async () => {
        throw new Error(`${String(name)} not used here`);
      },
    },
  ) as T;
}
const noServers = notUsed<UserHandlerDeps['serverOps']>();
const noInvites = notUsed<UserHandlerDeps['inviteOps']>();
const noMembers = notUsed<UserHandlerDeps['memberOps']>();
const noUploads = notUsed<UserHandlerDeps['uploadOps']>();

function event(
  routeKey: string,
  claims: Record<string, unknown> | undefined,
  opts: { id?: string; body?: string; query?: Record<string, string> } = {},
) {
  return {
    routeKey,
    queryStringParameters: opts.query,
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
      const res = await userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: (e) => logs.push(e) })(event('GET /v1/me', googleClaims));

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
      const res = await userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(event('GET /v1/me', googleClaims));
      expect(JSON.parse(res.body!)).toMatchObject({ approved: true, serverLimit: 5, name: 'Tarik', createdAt: '2026-10-01T00:00:00.000Z' });
    });

    it('says whether the caller is an admin, from their groups', async () => {
      const { store } = fakeUsers();
      const res = await userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(
        event('GET /v1/me', { ...googleClaims, 'cognito:groups': '[admin]' }),
      );
      expect(JSON.parse(res.body!).admin).toBe(true);
    });
  });

  it('answers 401 to an access token, or no claims at all', async () => {
    const { store } = fakeUsers();
    const handle = userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} });
    expect((await handle(event('GET /v1/me', { ...googleClaims, token_use: 'access' }))).statusCode).toBe(401);
    expect((await handle(event('GET /v1/me', undefined))).statusCode).toBe(401);
  });

  describe('servers', () => {
    const record: ServerRecord = {
      serverId: 's1',
      ownerId: SUB,
      game: 'minecraft-java',
      region: 'us-west-2',
      status: 'RUNNING',
      version: '26.3',
      autoUpdate: false,
      instanceId: 'i-1',
      publicIp: '35.1.2.3',
      lastBackupKey: 'servers/s1/x.tar.gz',
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    const calls: string[] = [];
    const serverOps: UserHandlerDeps['serverOps'] = {
      listMyServers: async (actor, all) => {
        calls.push(`list ${actor.kind} ${all}`);
        return [{ server: record, relation: 'owner' }];
      },
      getServer: async (actor, id) => {
        if (id !== 's1') throw new AccessDenied(404, `No server ${id}`);
        return { server: record, relation: actor.kind === 'admin' ? 'admin' : 'member' };
      },
      listServers: async (actor, limit, cursor, all) => {
        calls.push(`list every ${actor.kind} ${limit} ${cursor} ${all}`);
        if (actor.kind !== 'admin') throw new AccessDenied(403, 'Only Hearth admins can do that');
        return { servers: [record], cursor: 'next' };
      },
      createServer: async (actor, body) => {
        calls.push(`create ${actor.kind} ${JSON.stringify(body)}`);
        if ((body as { version?: string }).version === 'limit') throw new AccessDenied(403, 'You have 3 servers, your limit');
        return { serverId: 'new', status: 'PROVISIONING' };
      },
      startServer: async (actor, id) => {
        calls.push(`start ${actor.kind} ${id}`);
        return id === 'running' ? { serverId: id, status: 'RUNNING', unchanged: true } : { serverId: id, status: 'STARTING' };
      },
      stopServer: async (actor, id) => {
        calls.push(`stop ${actor.kind} ${id}`);
        return { serverId: id, status: 'STOPPING' };
      },
      destroyServer: async (actor, id) => {
        calls.push(`destroy ${actor.kind} ${id}`);
        if (id === 'theirs') throw new AccessDenied(403, "As a member, you can't destroy server theirs");
        return { serverId: id, status: 'DESTROYING' };
      },
      relationTo: async (actor) => (actor.kind === 'admin' ? 'admin' : 'owner'),
      updateSettings: async (actor, id, body) => {
        calls.push(`settings ${actor.kind} ${id} ${JSON.stringify(body)}`);
        return { ...record, idleStopMinutes: (body as { idleStopMinutes: number }).idleStopMinutes };
      },
      setVersion: async (actor, id, body) => {
        calls.push(`version ${actor.kind} ${id} ${JSON.stringify(body)}`);
        return { ...record, status: 'STOPPED', version: (body as { version: string }).version };
      },
      listBackups: async () => ({
        backups: [{ key: 'servers/s1/20261005T120000Z.tar.gz', takenAt: '2026-10-05T12:00:10.000Z', bytes: 2048 }],
      }),
      requestRestore: async (actor, id, body) => {
        calls.push(`restore ${actor.kind} ${id} ${JSON.stringify(body)}`);
        return { ...record, status: 'STOPPED', restoreKey: 'servers/s1/20261005T120000Z.tar.gz' };
      },
      cancelRestore: async (actor, id) => {
        calls.push(`cancel restore ${actor.kind} ${id}`);
        return { ...record, status: 'STOPPED' };
      },
    };
    const handle = () => {
      const { store } = fakeUsers();
      return userHandler({ users: store, serverOps, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), log: () => {} });
    };

    it('gives admins every server and whole records; everyone else 403', async () => {
      calls.length = 0;
      const admin = { ...googleClaims, 'cognito:groups': '[admin]' };
      const h = handle();
      const every = await h({ ...event('GET /v1/admin/servers', admin), queryStringParameters: { limit: '50', all: 'true' } } as never);
      expect(JSON.parse(every.body!)).toEqual({ servers: [record], cursor: 'next' });
      expect(calls).toEqual(['list every admin 50 undefined true']);
      const one = await h(event('GET /v1/admin/servers/{id}', admin, { id: 's1' }));
      expect(JSON.parse(one.body!)).toEqual(record); // instance ID, storage keys and all

      expect((await h(event('GET /v1/admin/servers', googleClaims))).statusCode).toBe(403);
      // An owner or member of s1 is still refused: this route answers whole records.
      expect((await h(event('GET /v1/admin/servers/{id}', googleClaims, { id: 's1' }))).statusCode).toBe(403);
    });

    it('lists my servers as the UI sees them: no instance IDs or storage keys', async () => {
      calls.length = 0;
      const res = await handle()(event('GET /v1/servers', googleClaims));
      expect(res.statusCode).toBe(200);
      const { servers } = JSON.parse(res.body!);
      expect(servers).toEqual([expect.objectContaining({ serverId: 's1', role: 'owner', address: '35.1.2.3' })]);
      expect(servers[0]).not.toHaveProperty('instanceId');
      expect(servers[0]).not.toHaveProperty('lastBackupKey');
      expect(calls).toEqual(['list user false']);
    });

    it('includes destroyed servers with all=true', async () => {
      calls.length = 0;
      await handle()(event('GET /v1/servers', googleClaims, { query: { all: 'true' } }));
      expect(calls).toEqual(['list user true']);
    });

    it('gets one server, with my relation to it, and 404 for one I cannot reach', async () => {
      const ok = await handle()(event('GET /v1/servers/{id}', googleClaims, { id: 's1' }));
      expect(JSON.parse(ok.body!)).toMatchObject({ serverId: 's1', role: 'member' });
      const missing = await handle()(event('GET /v1/servers/{id}', googleClaims, { id: 's2' }));
      expect(missing.statusCode).toBe(404);
    });

    it('creates a server as the caller, answering 202, or 403 with the reason', async () => {
      calls.length = 0;
      const created = await handle()(event('POST /v1/servers', googleClaims, { body: '{"game":"minecraft-java","version":"26.3"}' }));
      expect(created.statusCode).toBe(202);
      expect(JSON.parse(created.body!)).toEqual({ serverId: 'new', status: 'PROVISIONING' });
      expect(calls).toEqual(['create user {"game":"minecraft-java","version":"26.3"}']);

      const refused = await handle()(event('POST /v1/servers', googleClaims, { body: '{"game":"minecraft-java","version":"limit"}' }));
      expect(refused.statusCode).toBe(403);
      expect(JSON.parse(refused.body!).message).toMatch(/limit/);
    });

    it('starts, stops and destroys as the caller: 202 when a workflow started, 200 when unchanged', async () => {
      calls.length = 0;
      const h = handle();
      const start = await h(event('POST /v1/servers/{id}/start', googleClaims, { id: 's1' }));
      expect([start.statusCode, JSON.parse(start.body!).status]).toEqual([202, 'STARTING']);
      expect((await h(event('POST /v1/servers/{id}/start', googleClaims, { id: 'running' }))).statusCode).toBe(200);
      expect((await h(event('POST /v1/servers/{id}/stop', googleClaims, { id: 's1' }))).statusCode).toBe(202);
      expect((await h(event('POST /v1/servers/{id}/destroy', googleClaims, { id: 's1' }))).statusCode).toBe(202);
      expect(calls).toEqual(['start user s1', 'start user running', 'stop user s1', 'destroy user s1']);
    });

    it('changes settings, version and restores, answering the server as the caller sees it', async () => {
      calls.length = 0;
      const h = handle();
      const settings = await h(event('PATCH /v1/servers/{id}', googleClaims, { id: 's1', body: '{"idleStopMinutes":0}' }));
      expect(JSON.parse(settings.body!)).toMatchObject({ serverId: 's1', role: 'owner', idleStopMinutes: 0 });
      expect(JSON.parse(settings.body!)).not.toHaveProperty('instanceId');

      const version = await h(event('POST /v1/servers/{id}/version', googleClaims, { id: 's1', body: '{"version":"26.4"}' }));
      expect(JSON.parse(version.body!)).toMatchObject({ version: '26.4', status: 'STOPPED' });

      const restore = await h(event('POST /v1/servers/{id}/restore', googleClaims, { id: 's1', body: '{"key":"20261005T120000Z.tar.gz"}' }));
      expect(JSON.parse(restore.body!)).toMatchObject({ restorePending: true });
      expect(JSON.parse(restore.body!)).not.toHaveProperty('restoreKey');

      const cancel = await h(event('DELETE /v1/servers/{id}/restore', googleClaims, { id: 's1' }));
      expect(JSON.parse(cancel.body!)).toMatchObject({ restorePending: false });

      expect(calls).toEqual([
        'settings user s1 {"idleStopMinutes":0}',
        'version user s1 {"version":"26.4"}',
        'restore user s1 {"key":"20261005T120000Z.tar.gz"}',
        'cancel restore user s1',
      ]);
    });

    it('lists backups by id (their file name), never their storage key', async () => {
      const res = await handle()(event('GET /v1/servers/{id}/backups', googleClaims, { id: 's1' }));
      expect(JSON.parse(res.body!)).toEqual({
        backups: [{ id: '20261005T120000Z.tar.gz', takenAt: '2026-10-05T12:00:10.000Z', bytes: 2048 }],
      });
    });

    it("passes on the operations' refusals (a member destroying: 403)", async () => {
      const res = await handle()(event('POST /v1/servers/{id}/destroy', googleClaims, { id: 'theirs' }));
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body!).message).toMatch(/As a member/);
    });

    it('answers admins with the same view, not the whole record', async () => {
      const res = await handle()(event('GET /v1/servers/{id}', { ...googleClaims, 'cognito:groups': '[admin]' }, { id: 's1' }));
      const body = JSON.parse(res.body!);
      expect(body.role).toBe('admin');
      expect(body).not.toHaveProperty('instanceId');
    });
  });

  describe('invites', () => {
    const invite = { code: 'K7QX-M2PD-9VTR-H4NB-W3ZA', createdBy: SUB, createdAt: 'now', expiresAt: 'later' };
    const calls: string[] = [];
    const inviteOps: UserHandlerDeps['inviteOps'] = {
      createInvite: async (actor, id) => (calls.push(`create ${actor.kind} ${id}`), invite),
      listInvites: async (actor, id) => (calls.push(`list ${actor.kind} ${id}`), [invite]),
      revokeInvite: async (actor, id, code) => void calls.push(`revoke ${actor.kind} ${id} ${code}`),
      acceptInvite: async (actor, code) => {
        calls.push(`accept ${actor.kind} ${code}`);
        if (code === 'expired') throw new OperationError(404, 'No such invite: it may have expired or been revoked');
        return {
          server: { serverId: 's1', ownerId: 'o', game: 'minecraft-java', region: 'us-west-2', status: 'STOPPED', version: '26.3', autoUpdate: false, instanceId: 'i-1' },
          relation: 'member',
        };
      },
    };
    const handle = () => {
      const { store } = fakeUsers();
      return userHandler({ users: store, serverOps: noServers, inviteOps, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), log: () => {} });
    };

    it('creates (201), lists and revokes (204) invites as the caller', async () => {
      calls.length = 0;
      const h = handle();
      const created = await h(event('POST /v1/servers/{id}/invites', googleClaims, { id: 's1' }));
      expect([created.statusCode, JSON.parse(created.body!).code]).toEqual([201, invite.code]);
      const listed = await h(event('GET /v1/servers/{id}/invites', googleClaims, { id: 's1' }));
      expect(JSON.parse(listed.body!)).toEqual({ invites: [invite] });
      const revoked = await h({
        ...event('DELETE /v1/servers/{id}/invites/{code}', googleClaims),
        pathParameters: { id: 's1', code: invite.code },
      } as never);
      expect(revoked.statusCode).toBe(204);
      expect(calls).toEqual(['create user s1', 'list user s1', `revoke user s1 ${invite.code}`]);
    });

    it('accepts an invite, answering the server as a member sees it, or 404', async () => {
      const h = handle();
      const ok = await h({ ...event('POST /v1/invites/{code}/accept', googleClaims), pathParameters: { code: invite.code } } as never);
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body!)).toMatchObject({ serverId: 's1', role: 'member' });
      expect(JSON.parse(ok.body!)).not.toHaveProperty('instanceId');
      const expired = await h({ ...event('POST /v1/invites/{code}/accept', googleClaims), pathParameters: { code: 'expired' } } as never);
      expect(expired.statusCode).toBe(404);
    });
  });

  describe('members', () => {
    const member = { userId: 'f', role: 'member' as const, name: 'Friend', addedAt: 'then', addedBy: SUB };
    const calls: string[] = [];
    const memberOps: UserHandlerDeps['memberOps'] = {
      listMembers: async (actor, id) => (calls.push(`list ${actor.kind} ${id}`), [member]),
      removeMember: async (actor, id, userId) => {
        calls.push(`remove ${actor.kind} ${id} ${userId}`);
        if (userId === SUB) throw new OperationError(409, 'an owner can\'t be removed');
      },
      leaveServer: async (actor, id) => void calls.push(`leave ${actor.kind} ${id}`),
    };
    const handle = () => {
      const { store } = fakeUsers();
      return userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), log: () => {} });
    };

    it('lists, removes (204) and leaves (204) as the caller; refusals pass through', async () => {
      calls.length = 0;
      const h = handle();
      const listed = await h(event('GET /v1/servers/{id}/members', googleClaims, { id: 's1' }));
      expect(JSON.parse(listed.body!)).toEqual({ members: [member] });
      const remove = (userId: string) =>
        h({ ...event('DELETE /v1/servers/{id}/members/{user}', googleClaims), pathParameters: { id: 's1', user: userId } } as never);
      expect((await remove('f')).statusCode).toBe(204);
      expect((await remove(SUB)).statusCode).toBe(409);
      expect((await h(event('POST /v1/servers/{id}/leave', googleClaims, { id: 's1' }))).statusCode).toBe(204);
      expect(calls).toEqual(['list user s1', 'remove user s1 f', `remove user s1 ${SUB}`, 'leave user s1']);
    });
  });

  describe('uploads', () => {
    const UPLOAD = '01K6ABCDEF0123456789ABCDEF';
    const calls: string[] = [];
    const uploadOps: UserHandlerDeps['uploadOps'] = {
      createUpload: async (actor, body) => {
        calls.push(`create ${actor.kind} ${JSON.stringify(body)}`);
        return { uploadId: UPLOAD, url: 'https://s3/', fields: { key: 'k' }, maxBytes: 1, expiresAt: 'later' };
      },
      uploadStatus: async (actor, id) => {
        calls.push(`status ${actor.kind} ${id}`);
        if (id !== UPLOAD) throw new OperationError(404, `No upload ${id} (never uploaded, or expired)`);
        return { uploadId: id, status: 'repacking' };
      },
    };
    const handle = () => {
      const { store } = fakeUsers();
      return userHandler({
        users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps,
        userOps: userOperations({ users: store, now: () => NOW }), log: () => {},
      });
    };

    it('starts an upload (201) and reports on it as the caller; refusals pass through', async () => {
      calls.length = 0;
      const h = handle();
      const created = await h({ ...event('POST /v1/uploads', googleClaims), body: '{"game":"minecraft-java"}' } as never);
      expect([created.statusCode, JSON.parse(created.body!).uploadId]).toEqual([201, UPLOAD]);
      const status = await h(event('GET /v1/uploads/{id}', googleClaims, { id: UPLOAD }));
      expect(JSON.parse(status.body!)).toEqual({ uploadId: UPLOAD, status: 'repacking' });
      expect((await h(event('GET /v1/uploads/{id}', googleClaims, { id: 'nope' }))).statusCode).toBe(404);
      expect(calls).toEqual(['create user {"game":"minecraft-java"}', `status user ${UPLOAD}`, 'status user nope']);
    });
  });

  describe('POST /v1/admin/users/{id}/approval', () => {
    const ROUTE = 'POST /v1/admin/users/{id}/approval';
    const admin = { ...googleClaims, 'cognito:groups': '[admin]' };
    const setup = () => {
      const { store, users } = fakeUsers([{ userId: 'friend', approved: false, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then' }]);
      const logs: Record<string, unknown>[] = [];
      const handle = userHandler({
        users: store,
        serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }),
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

    it("refuses an admin's own approval with 409 (admins need none), changing nothing", async () => {
      const { handle, users } = setup();
      users.set(SUB, { userId: SUB, approved: true, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then' });
      const res = await handle(event(ROUTE, admin, { id: SUB, body: '{"approved":false}' }));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body!).message).toMatch(/your own approval/);
      expect(users.get(SUB)?.approved).toBe(true);
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
    const res = await userHandler({ users: store, serverOps: noServers, inviteOps: noInvites, memberOps: noMembers, uploadOps: noUploads, userOps: userOperations({ users: store, now: () => NOW }), now: () => NOW, log: () => {} })(event('GET /v1/nope', googleClaims));
    expect(res.statusCode).toBe(404);
  });
});
