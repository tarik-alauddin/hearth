import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerRecord } from '@hearth/shared';
import { InvalidCursor } from '@hearth/core';
import { OperationError, serverOperations, type OperationDeps, type WorkflowName } from './operations.js';

const NOW = new Date('2026-09-29T12:00:00Z');

function fakeStore(initial: ServerRecord[] = []) {
  const servers = new Map(initial.map((s) => [s.serverId, { ...s }]));
  const store: OperationDeps['store'] = {
    getServer: async (id) => (servers.has(id) ? { ...servers.get(id)! } : undefined),
    listServers: async ({ limit, cursor }) => {
      if (cursor === 'bad') throw new InvalidCursor('Invalid cursor');
      return { servers: [...servers.values()].slice(0, limit) };
    },
    createServer: async (server) => {
      if (servers.has(server.serverId)) throw new Error('exists');
      servers.set(server.serverId, { ...server });
    },
    transition: async (id, { from, to, instanceId, set = {} }) => {
      const s = servers.get(id);
      if (!s || !from.includes(s.status) || (instanceId !== undefined && s.instanceId !== instanceId)) return false;
      Object.assign(s, set, { status: to });
      return true;
    },
  };
  return { store, servers };
}

function server(overrides: Partial<ServerRecord>): ServerRecord {
  return {
    serverId: 's1',
    ownerId: 'o',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'STOPPED',
    version: '1.21.4',
    autoUpdate: false,
    instanceId: 'i-1',
    ...overrides,
  };
}

describe('server operations', () => {
  let started: { workflow: WorkflowName; serverId: string; operationId: string }[];
  let failWorkflows: boolean;
  let ids: number;

  const ops = (store: OperationDeps['store']) =>
    serverOperations({
      store,
      workflows: {
        start: async (workflow, serverId, operationId) => {
          if (failWorkflows) throw new Error('Step Functions unavailable');
          started.push({ workflow, serverId, operationId });
        },
      },
      homeRegion: 'us-west-2',
      gameRegions: ['us-west-2'],
      now: () => NOW,
      newId: () => `ID${ids++}`,
    });

  beforeEach(() => {
    started = [];
    failWorkflows = false;
    ids = 1;
  });

  describe('create', () => {
    it('records a PROVISIONING server and starts the create workflow', async () => {
      const { store, servers } = fakeStore();
      const result = await ops(store).createServer({ game: 'minecraft-java', version: '1.21.4' }, 'arn:caller');
      expect(result).toEqual({ serverId: 'ID1', status: 'PROVISIONING' });
      expect(servers.get('ID1')).toMatchObject({
        ownerId: 'arn:caller',
        region: 'us-west-2',
        status: 'PROVISIONING',
        createdAt: NOW.toISOString(),
        lastOperationId: 'ID2',
      });
      expect(started).toEqual([{ workflow: 'create', serverId: 'ID1', operationId: 'ID2' }]);
    });

    it.each([
      ['an unknown game', { game: 'tetris', version: '1' }],
      ['a bad version', { game: 'minecraft-java', version: '1.21; rm -rf' }],
      ['a region without game infrastructure', { game: 'minecraft-java', version: '1.21.4', region: 'eu-west-1' }],
      ['a non-object body', 'hello'],
    ])('rejects %s with 400', async (_, body) => {
      await expect(ops(fakeStore().store).createServer(body, 'c')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('marks the server FAILED if the workflow cannot start', async () => {
      const { store, servers } = fakeStore();
      failWorkflows = true;
      await expect(ops(store).createServer({ game: 'minecraft-java', version: '1.21.4' }, 'c')).rejects.toThrow();
      expect(servers.get('ID1')).toMatchObject({ status: 'FAILED', statusMessage: "Couldn't start the create workflow" });
    });
  });

  describe('start', () => {
    it('claims STOPPED → STARTING and starts the start workflow', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      expect(await ops(store).startServer('s1')).toEqual({ serverId: 's1', status: 'STARTING' });
      expect(servers.get('s1')).toMatchObject({ status: 'STARTING', lastOperationId: 'ID1' });
      expect(started).toEqual([{ workflow: 'start', serverId: 's1', operationId: 'ID1' }]);
    });

    it('recovers a FAILED server with an instance by starting it', async () => {
      const { store } = fakeStore([server({ status: 'FAILED' })]);
      await ops(store).startServer('s1');
      expect(started[0]?.workflow).toBe('start');
    });

    it('re-runs create for a FAILED server that never got an instance', async () => {
      const { store, servers } = fakeStore([server({ status: 'FAILED', instanceId: undefined })]);
      expect(await ops(store).startServer('s1')).toEqual({ serverId: 's1', status: 'PROVISIONING' });
      expect(servers.get('s1')?.status).toBe('PROVISIONING');
      expect(started[0]?.workflow).toBe('create');
    });

    it.each(['RUNNING', 'STARTING'] as const)('does nothing when already %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect(await ops(store).startServer('s1')).toEqual({ serverId: 's1', status, unchanged: true });
      expect(started).toEqual([]);
    });

    it('refuses to start a stopping server', async () => {
      const { store } = fakeStore([server({ status: 'STOPPING' })]);
      await expect(ops(store).startServer('s1')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('puts the server back to STOPPED if the workflow cannot start', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      failWorkflows = true;
      await expect(ops(store).startServer('s1')).rejects.toThrow('unavailable');
      expect(servers.get('s1')?.status).toBe('STOPPED');
    });

    it('lets only one of two simultaneous starts through', async () => {
      const { store } = fakeStore([server({ status: 'STOPPED' })]);
      const results = await Promise.allSettled([ops(store).startServer('s1'), ops(store).startServer('s1')]);
      expect(started).toHaveLength(1);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'fulfilled']);
    });

    it('returns 404 for an unknown server', async () => {
      await expect(ops(fakeStore().store).startServer('nope')).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('list', () => {
    const three = [server({ serverId: 'a' }), server({ serverId: 'b' }), server({ serverId: 'c' })];

    it('defaults to 50 per page and honours a smaller limit', async () => {
      const { store } = fakeStore(three);
      expect((await ops(store).listServers(undefined, undefined)).servers).toHaveLength(3);
      expect((await ops(store).listServers('2', undefined)).servers).toHaveLength(2);
    });

    it.each(['0', '101', '2.5', 'ten'])('rejects limit=%s with 400', async (limit) => {
      await expect(ops(fakeStore(three).store).listServers(limit, undefined)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects an invalid cursor with 400', async () => {
      await expect(ops(fakeStore(three).store).listServers(undefined, 'bad')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('stop', () => {
    it('claims RUNNING → STOPPING and starts the stop workflow', async () => {
      const { store, servers } = fakeStore([server({ status: 'RUNNING' })]);
      expect(await ops(store).stopServer('s1')).toEqual({ serverId: 's1', status: 'STOPPING' });
      expect(servers.get('s1')?.status).toBe('STOPPING');
      expect(started[0]?.workflow).toBe('stop');
    });

    it.each(['STOPPED', 'STOPPING'] as const)('does nothing when already %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect((await ops(store).stopServer('s1')).unchanged).toBe(true);
    });

    it('refuses to stop a server that is still starting', async () => {
      const { store } = fakeStore([server({ status: 'STARTING' })]);
      await expect(ops(store).stopServer('s1')).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
