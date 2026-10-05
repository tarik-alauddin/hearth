import type { APIGatewayProxyEventV2WithIAMAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import type { ServerOperationResult } from '@hearth/shared';
import { OperationError, type serverOperations } from '../servers/operations.js';
import { adminHandler } from './handlers.js';

const ADMIN = 'arn:aws:iam::138300868928:user/admin';
const INSTANCE = 'arn:aws:sts::138300868928:assumed-role/hearth-dev-InstanceRole/i-0123456789abcdef0';

function event(
  routeKey: string,
  opts: { id?: string; body?: string; caller?: string; query?: Record<string, string> } = {},
) {
  return {
    routeKey,
    queryStringParameters: opts.query,
    pathParameters: opts.id ? { id: opts.id } : undefined,
    body: opts.body,
    isBase64Encoded: false,
    requestContext: { authorizer: { iam: { userArn: opts.caller ?? ADMIN } } },
  } as unknown as APIGatewayProxyEventV2WithIAMAuthorizer;
}

function fakeOperations(): { calls: string[]; ops: ReturnType<typeof serverOperations> } {
  const calls: string[] = [];
  const result = (serverId: string, unchanged = false): ServerOperationResult => ({
    serverId,
    status: 'STARTING',
    ...(unchanged ? { unchanged } : {}),
  });
  const ops = {
    getServer: async (id: string) => {
      if (id === 'missing') throw new OperationError(404, 'No server missing');
      calls.push(`get ${id}`);
      return { serverId: id };
    },
    listServers: async (limit?: string, cursor?: string) => {
      calls.push(`list ${limit} ${cursor}`);
      return { servers: [{ serverId: 's1' }] };
    },
    createServer: async (body: unknown, owner: string) => {
      calls.push(`create ${JSON.stringify(body)} ${owner}`);
      return result('new');
    },
    updateSettings: async (id: string, body: unknown) => {
      calls.push(`settings ${id} ${JSON.stringify(body)}`);
      return { serverId: id, agentChannel: 'canary' };
    },
    startServer: async (id: string) => result(id, id === 'running'),
    stopServer: async (id: string) => result(id),
    listBackups: async (id: string) => {
      if (id === 'missing') throw new OperationError(404, 'No server missing');
      return { backups: BACKUPS };
    },
    requestRestore: async (id: string, body: unknown) => {
      calls.push(`restore ${id} ${JSON.stringify(body)}`);
      return { serverId: id, restoreKey: BACKUPS[0]!.key };
    },
    setVersion: async (id: string, body: unknown) => {
      calls.push(`version ${id} ${JSON.stringify(body)}`);
      return { serverId: id, version: '26.3' };
    },
    cancelRestore: async (id: string) => {
      calls.push(`cancel restore ${id}`);
      return { serverId: id };
    },
  } as unknown as ReturnType<typeof serverOperations>;
  return { calls, ops };
}

const BACKUPS = [
  { key: 'servers/s1/20261005T120000Z.tar.gz', takenAt: '2026-10-05T12:00:10.000Z', bytes: 2048 },
  { key: 'servers/s1/20261004T120000Z.tar.gz', takenAt: '2026-10-04T12:00:10.000Z', bytes: 1024 },
];

const handle = (ops: ReturnType<typeof serverOperations>) =>
  adminHandler({ operations: ops, instanceRoleNames: ['hearth-dev-InstanceRole'], log: () => {} });

describe('admin routes', () => {
  it('creates a server owned by the caller and answers 202', async () => {
    const { calls, ops } = fakeOperations();
    const res = await handle(ops)(event('POST /admin/servers', { body: '{"game":"minecraft-java","version":"1.21.4"}' }));
    expect(res.statusCode).toBe(202);
    expect(calls).toEqual([`create {"game":"minecraft-java","version":"1.21.4"} ${ADMIN}`]);
  });

  it('lists and gets servers', async () => {
    const { ops } = fakeOperations();
    expect(JSON.parse((await handle(ops)(event('GET /admin/servers'))).body!)).toEqual({ servers: [{ serverId: 's1' }] });
    expect((await handle(ops)(event('GET /admin/servers/{id}', { id: 's1' }))).statusCode).toBe(200);
  });

  it('passes paging parameters through', async () => {
    const { calls, ops } = fakeOperations();
    await handle(ops)(event('GET /admin/servers', { query: { limit: '10', cursor: 'abc' } }));
    expect(calls).toEqual(['list 10 abc']);
  });

  it('answers 202 for a started operation and 200 when nothing changed', async () => {
    const { ops } = fakeOperations();
    expect((await handle(ops)(event('POST /admin/servers/{id}/start', { id: 's1' }))).statusCode).toBe(202);
    expect((await handle(ops)(event('POST /admin/servers/{id}/start', { id: 'running' }))).statusCode).toBe(200);
    expect((await handle(ops)(event('POST /admin/servers/{id}/stop', { id: 's1' }))).statusCode).toBe(202);
  });

  it('changes settings', async () => {
    const { calls, ops } = fakeOperations();
    const res = await handle(ops)(event('POST /admin/servers/{id}/settings', { id: 's1', body: '{"agentChannel":"canary"}' }));
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual(['settings s1 {"agentChannel":"canary"}']);
  });

  it('maps operation errors to their status codes', async () => {
    const { ops } = fakeOperations();
    const res = await handle(ops)(event('GET /admin/servers/{id}', { id: 'missing' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body!)).toEqual({ message: 'No server missing' });
  });

  it("lists a server's backups, newest first", async () => {
    const { ops } = fakeOperations();
    const res = await handle(ops)(event('GET /admin/servers/{id}/backups', { id: 's1' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ backups: BACKUPS });
  });

  it('answers 404 for the backups of an unknown server', async () => {
    const { ops } = fakeOperations();
    const res = await handle(ops)(event('GET /admin/servers/{id}/backups', { id: 'missing' }));
    expect(res.statusCode).toBe(404);
  });

  it('sets the version, answering with the server', async () => {
    const { calls, ops } = fakeOperations();
    const res = await handle(ops)(event('POST /admin/servers/{id}/version', { id: 's1', body: '{"version":"26.3"}' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).version).toBe('26.3');
    expect(calls).toEqual(['version s1 {"version":"26.3"}']);
  });

  it('requests and cancels a restore, answering with the server', async () => {
    const { calls, ops } = fakeOperations();
    const res = await handle(ops)(event('POST /admin/servers/{id}/restore', { id: 's1', body: '{"force":true}' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).restoreKey).toBe(BACKUPS[0]!.key);
    const cancel = await handle(ops)(event('POST /admin/servers/{id}/restore/cancel', { id: 's1' }));
    expect(cancel.statusCode).toBe(200);
    expect(calls).toEqual(['restore s1 {"force":true}', 'cancel restore s1']);
  });

  it('rejects a body that is not JSON', async () => {
    const { ops } = fakeOperations();
    expect((await handle(ops)(event('POST /admin/servers', { body: 'nope' }))).statusCode).toBe(400);
  });

  it('refuses game instances', async () => {
    const { calls, ops } = fakeOperations();
    const res = await handle(ops)(event('GET /admin/servers/{id}', { id: 's1', caller: INSTANCE }));
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });
});
