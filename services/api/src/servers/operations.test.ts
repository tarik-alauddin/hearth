import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerAccessRecord, ServerRecord } from '@hearth/shared';
import { InvalidCursor } from '@hearth/core';
import type { Actor } from '../authz.js';
import type { StoredUpload } from '../uploads.js';
import { OperationError, serverOperations, type OperationDeps, type WorkflowName } from './operations.js';

const ADMIN: Actor = { kind: 'admin', id: 'arn:admin' };
const admin = (id: string): Actor => ({ kind: 'admin', id });
const agent = (serverId: string, instanceId: string) => ({ kind: 'agent' as const, serverId, instanceId });

const NOW = new Date('2026-09-29T12:00:00Z');
const NEWEST = 'servers/s1/20261005T120000Z.tar.gz';
const OLDER = 'servers/s1/20261004T120000Z.tar.gz';
// Uploads in each state repack can leave them in (IDs are ULIDs).
const ACCEPTED = '01K6ACCEPTED00000000000000';
const OLD_ACCEPTED = '01K6ACCEPTED0000000000000Z'; // accepted before repack recorded the game
const REPACKING = '01K6REPACKNG00000000000000';
const REJECTED = '01K6REJECTED00000000000000';
const OTHER_GAME = '01K6THERGAME00000000000000';
// u1 uploaded ACCEPTED; the others were uploaded by admins, or before uploaders were recorded.
const UPLOADS: Record<string, StoredUpload> = {
  [ACCEPTED]: { status: { uploadId: ACCEPTED, status: 'accepted', bytes: 100, game: 'minecraft-java' }, uploader: 'u1' },
  [OLD_ACCEPTED]: { status: { uploadId: OLD_ACCEPTED, status: 'accepted', bytes: 100 } },
  [REPACKING]: { status: { uploadId: REPACKING, status: 'repacking' } },
  [REJECTED]: { status: { uploadId: REJECTED, status: 'rejected', reason: 'no level.dat found' } },
  [OTHER_GAME]: { status: { uploadId: OTHER_GAME, status: 'accepted', bytes: 100, game: 'terraria' } },
};

const BACKUPS = [
  { key: NEWEST, takenAt: '2026-10-05T12:00:10.000Z', bytes: 2048 },
  { key: OLDER, takenAt: '2026-10-04T12:00:10.000Z', bytes: 1024 },
];

function fakeStore(initial: ServerRecord[] = []) {
  const servers = new Map(initial.map((s) => [s.serverId, { ...s }]));
  const store: OperationDeps['store'] = {
    getServer: async (id) => (servers.has(id) ? { ...servers.get(id)! } : undefined),
    listServers: async ({ limit, cursor, includeDestroyed }) => {
      if (cursor === 'bad') throw new InvalidCursor('Invalid cursor');
      const shown = [...servers.values()].filter((s) => includeDestroyed || s.status !== 'DESTROYED');
      return { servers: shown.slice(0, limit) };
    },
    createServer: async (server) => {
      if (servers.has(server.serverId)) throw new Error('exists');
      servers.set(server.serverId, { ...server });
    },
    countActiveOwned: async (ownerId) => [...servers.values()].filter((s) => s.ownerId === ownerId && s.status !== 'DESTROYED').length,
    updateSettings: async (id, settings) => {
      const s = servers.get(id);
      if (!s) return false;
      Object.assign(s, settings);
      return true;
    },
    transition: async (id, { from, to, instanceId, set = {}, remove = [] }) => {
      const s = servers.get(id);
      if (!s || !from.includes(s.status) || (instanceId !== undefined && s.instanceId !== instanceId)) return false;
      Object.assign(s, set, { status: to });
      for (const field of remove) delete s[field];
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

  const ops = (store: OperationDeps['store'], access?: OperationDeps['access'], extra: Partial<OperationDeps> = {}) =>
    serverOperations({
      store,
      ...(access ? { access } : {}),
      ...extra,
      workflows: {
        start: async (workflow, serverId, operationId) => {
          if (failWorkflows) throw new Error('Step Functions unavailable');
          started.push({ workflow, serverId, operationId });
        },
      },
      backups: { list: async (id) => (id === 's1' ? BACKUPS : []) },
      uploads: {
        status: async (uploadId) => UPLOADS[uploadId],
        accepted: (uploadId) => ({ bucket: 'uploads', key: `accepted/${uploadId}.tar.gz` }),
      },
      versions: { releases: async () => ['1.21.4', '26.1', '26.3'] },
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

  describe('create from an upload', () => {
    const create = (store: OperationDeps['store'], upload: unknown) =>
      ops(store).createServer(admin('arn:caller'), { game: 'minecraft-java', version: '26.3', upload });

    it('restores the accepted upload, straight from the uploads bucket, on the first start', async () => {
      const { store, servers } = fakeStore();
      expect(await create(store, ACCEPTED)).toEqual({ serverId: 'ID1', status: 'PROVISIONING' });
      expect(servers.get('ID1')).toMatchObject({
        status: 'PROVISIONING',
        restoreKey: `accepted/${ACCEPTED}.tar.gz`,
        restoreSource: 'upload',
        restoreRequestedAt: NOW.toISOString(),
      });
      expect(started[0]?.workflow).toBe('create');
    });

    it('takes an upload accepted before repack recorded its game', async () => {
      const { store, servers } = fakeStore();
      await create(store, OLD_ACCEPTED);
      expect(servers.get('ID1')?.restoreKey).toBe(`accepted/${OLD_ACCEPTED}.tar.gz`);
    });

    it.each([
      ['still repacking', REPACKING, 409, /still being checked/],
      ['rejected, with the reason', REJECTED, 409, /rejected: no level.dat found/],
      ['for another game', OTHER_GAME, 409, /for terraria, not minecraft-java/],
      ['unknown', '01K6NKNWN00000000000000000', 404, /never uploaded, or expired/],
      ['not an upload ID', '../etc/passwd', 404, /No upload/],
    ])('refuses an upload that is %s, creating nothing', async (_, upload, statusCode, message) => {
      const { store, servers } = fakeStore();
      const err = await create(store, upload).catch((e: OperationError) => e);
      expect(err).toMatchObject({ statusCode });
      expect(String(err)).toMatch(message);
      expect(servers.size).toBe(0);
      expect(started).toEqual([]);
    });

    it('returns 400 for an upload that is not a string', async () => {
      await expect(create(fakeStore().store, 42)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('create', () => {
    it('records a PROVISIONING server and starts the create workflow', async () => {
      const { store, servers } = fakeStore();
      const result = await ops(store).createServer(admin('arn:caller'), { game: 'minecraft-java', version: '1.21.4' });
      expect(result).toEqual({ serverId: 'ID1', status: 'PROVISIONING' });
      expect(servers.get('ID1')).toMatchObject({
        ownerId: 'arn:caller',
        region: 'us-west-2',
        status: 'PROVISIONING',
        agentChannel: 'stable',
        createdAt: NOW.toISOString(),
        statusChangedAt: NOW.toISOString(),
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
      await expect(ops(fakeStore().store).createServer(admin('c'), body)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('puts a server on the requested agent channel', async () => {
      const { store, servers } = fakeStore();
      await ops(store).createServer(admin('c'), { game: 'minecraft-java', version: '1.21.4', agentChannel: 'canary' });
      expect(servers.get('ID1')?.agentChannel).toBe('canary');
    });

    it('rejects an unknown agent channel', async () => {
      const body = { game: 'minecraft-java', version: '1.21.4', agentChannel: 'beta' };
      await expect(ops(fakeStore().store).createServer(admin('c'), body)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('marks the server FAILED if the workflow cannot start', async () => {
      const { store, servers } = fakeStore();
      failWorkflows = true;
      await expect(ops(store).createServer(admin('c'), { game: 'minecraft-java', version: '1.21.4' })).rejects.toThrow();
      expect(servers.get('ID1')).toMatchObject({ status: 'FAILED', statusMessage: "Couldn't start the create workflow" });
    });
  });

  describe('start', () => {
    it('claims STOPPED → STARTING and starts the start workflow', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      expect(await ops(store).startServer(ADMIN, 's1')).toEqual({ serverId: 's1', status: 'STARTING' });
      expect(servers.get('s1')).toMatchObject({ status: 'STARTING', lastOperationId: 'ID1' });
      expect(started).toEqual([{ workflow: 'start', serverId: 's1', operationId: 'ID1' }]);
    });

    it('recovers a FAILED server with an instance by starting it', async () => {
      const { store } = fakeStore([server({ status: 'FAILED' })]);
      await ops(store).startServer(ADMIN, 's1');
      expect(started[0]?.workflow).toBe('start');
    });

    it('re-runs create for a FAILED server that never got an instance', async () => {
      const { store, servers } = fakeStore([server({ status: 'FAILED', instanceId: undefined })]);
      expect(await ops(store).startServer(ADMIN, 's1')).toEqual({ serverId: 's1', status: 'PROVISIONING' });
      expect(servers.get('s1')?.status).toBe('PROVISIONING');
      expect(started[0]?.workflow).toBe('create');
    });

    it.each(['RUNNING', 'STARTING'] as const)('does nothing when already %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect(await ops(store).startServer(ADMIN, 's1')).toEqual({ serverId: 's1', status, unchanged: true });
      expect(started).toEqual([]);
    });

    it('refuses to start a stopping server', async () => {
      const { store } = fakeStore([server({ status: 'STOPPING' })]);
      await expect(ops(store).startServer(ADMIN, 's1')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('puts the server back to STOPPED if the workflow cannot start', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      failWorkflows = true;
      await expect(ops(store).startServer(ADMIN, 's1')).rejects.toThrow('unavailable');
      expect(servers.get('s1')?.status).toBe('STOPPED');
    });

    it('lets only one of two simultaneous starts through', async () => {
      const { store } = fakeStore([server({ status: 'STOPPED' })]);
      const results = await Promise.allSettled([ops(store).startServer(ADMIN, 's1'), ops(store).startServer(ADMIN, 's1')]);
      expect(started).toHaveLength(1);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'fulfilled']);
    });

    it('returns 404 for an unknown server', async () => {
      await expect(ops(fakeStore().store).startServer(ADMIN, 'nope')).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('list', () => {
    const three = [server({ serverId: 'a' }), server({ serverId: 'b' }), server({ serverId: 'c' })];

    it('defaults to 50 per page and honours a smaller limit', async () => {
      const { store } = fakeStore(three);
      expect((await ops(store).listServers(ADMIN, undefined, undefined)).servers).toHaveLength(3);
      expect((await ops(store).listServers(ADMIN, '2', undefined)).servers).toHaveLength(2);
    });

    it.each(['0', '101', '2.5', 'ten'])('rejects limit=%s with 400', async (limit) => {
      await expect(ops(fakeStore(three).store).listServers(ADMIN, limit, undefined)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects an invalid cursor with 400', async () => {
      await expect(ops(fakeStore(three).store).listServers(ADMIN, undefined, 'bad')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('leaves destroyed servers out unless all are asked for', async () => {
      const { store } = fakeStore([...three, server({ serverId: 'gone', status: 'DESTROYED' })]);
      expect((await ops(store).listServers(ADMIN, undefined, undefined)).servers.map((s) => s.serverId)).toEqual(['a', 'b', 'c']);
      expect((await ops(store).listServers(ADMIN, undefined, undefined, true)).servers).toHaveLength(4);
    });
  });

  describe('settings', () => {
    it('changes the agent channel and returns the server', async () => {
      const { store } = fakeStore([server({})]);
      expect((await ops(store).updateSettings(ADMIN, 's1', { agentChannel: 'canary' })).agentChannel).toBe('canary');
    });

    it('changes the idle limit, alone or with the channel, 0 meaning never', async () => {
      const { store, servers } = fakeStore([server({})]);
      expect((await ops(store).updateSettings(ADMIN, 's1', { idleStopMinutes: 45 })).idleStopMinutes).toBe(45);
      await ops(store).updateSettings(ADMIN, 's1', { idleStopMinutes: 0, agentChannel: 'canary' });
      expect(servers.get('s1')).toMatchObject({ idleStopMinutes: 0, agentChannel: 'canary' });
    });

    it.each([
      ['no settings', {}],
      ['an unknown setting', { agentChannel: 'canary', difficulty: 'hard' }],
      ['an unknown channel', { agentChannel: 'nightly' }],
      ['a negative idle limit', { idleStopMinutes: -1 }],
      ['a fractional idle limit', { idleStopMinutes: 2.5 }],
      ['an idle limit over a day', { idleStopMinutes: 1441 }],
      ['an idle limit as a string', { idleStopMinutes: '30' }],
    ])('rejects %s with 400', async (_, body) => {
      await expect(ops(fakeStore([server({})]).store).updateSettings(ADMIN, 's1', body)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('returns 404 for an unknown server', async () => {
      await expect(ops(fakeStore().store).updateSettings(ADMIN, 'nope', { agentChannel: 'stable' })).rejects.toMatchObject({
        statusCode: 404,
      });
    });
  });

  describe('stop', () => {
    it('claims RUNNING → STOPPING and starts the stop workflow', async () => {
      const { store, servers } = fakeStore([server({ status: 'RUNNING', stopReason: 'no players for 30 minutes' })]);
      expect(await ops(store).stopServer(ADMIN, 's1')).toEqual({ serverId: 's1', status: 'STOPPING' });
      expect(servers.get('s1')?.status).toBe('STOPPING');
      expect(servers.get('s1')).not.toHaveProperty('stopReason'); // an asked-for stop has no reason
      expect(started[0]?.workflow).toBe('stop');
    });

    it.each(['STOPPED', 'STOPPING'] as const)('does nothing when already %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect((await ops(store).stopServer(ADMIN, 's1')).unchanged).toBe(true);
    });

    it('refuses to stop a server that is still starting', async () => {
      const { store } = fakeStore([server({ status: 'STARTING' })]);
      await expect(ops(store).stopServer(ADMIN, 's1')).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('destroy', () => {
    it('claims a STOPPED server as DESTROYING and starts the destroy workflow', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED', instanceState: 'stopped' })]);
      expect(await ops(store).destroyServer(ADMIN, 's1')).toEqual({ serverId: 's1', status: 'DESTROYING' });
      expect(servers.get('s1')?.status).toBe('DESTROYING');
      expect(started[0]?.workflow).toBe('destroy');
    });

    it.each([
      ['its instance stopped', { instanceState: 'stopped' as const }],
      ['no instance at all', { instanceId: undefined }],
    ])('destroys a FAILED server with %s', async (_, overrides) => {
      const { store } = fakeStore([server({ status: 'FAILED', ...overrides })]);
      expect((await ops(store).destroyServer(ADMIN, 's1')).status).toBe('DESTROYING');
    });

    it.each([
      ['RUNNING', {}],
      ['STARTING', {}],
      ['STOPPING', {}],
      ['PROVISIONING', {}],
      ['FAILED', { instanceState: 'running' as const }],
      ['FAILED', { instanceState: 'pending' as const }],
    ])('never destroys a %s server whose instance may be up (%j)', async (status, overrides) => {
      const { store, servers } = fakeStore([server({ status: status as ServerRecord['status'], ...overrides })]);
      await expect(ops(store).destroyServer(ADMIN, 's1')).rejects.toThrow(/stop it before destroying it/);
      expect(servers.get('s1')?.status).toBe(status);
      expect(started).toEqual([]);
    });

    it.each(['DESTROYING', 'DESTROYED'] as const)('does nothing more for a %s server', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect(await ops(store).destroyServer(ADMIN, 's1')).toEqual({ serverId: 's1', status, unchanged: true });
      expect(started).toEqual([]);
    });

    it('a destroyed server can no longer be started, stopped, restored, upgraded or reconfigured', async () => {
      const { store } = fakeStore([server({ status: 'DESTROYED', lastStopClean: true })]);
      const o = ops(store);
      for (const attempt of [
        o.startServer(ADMIN, 's1'),
        o.stopServer(ADMIN, 's1'),
        o.requestRestore(ADMIN, 's1', {}),
        o.setVersion(ADMIN, 's1', { version: '26.3' }),
        o.updateSettings(ADMIN, 's1', { agentChannel: 'canary' }),
      ]) {
        await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
      }
      expect(started).toEqual([]);
      expect((await o.listBackups(ADMIN, 's1')).backups).toEqual(BACKUPS); // its backups are still listed
    });

    it('puts the server back if the workflow cannot start', async () => {
      failWorkflows = true;
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      await expect(ops(store).destroyServer(ADMIN, 's1')).rejects.toThrow();
      expect(servers.get('s1')?.status).toBe('STOPPED');
    });

    it('returns 404 for an unknown server', async () => {
      await expect(ops(fakeStore().store).destroyServer(ADMIN, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('idle stop', () => {
    it('stops a running server through the stop workflow, recording why', async () => {
      const { store, servers } = fakeStore([server({ status: 'RUNNING' })]);
      expect(await ops(store).idleStop(agent('s1', 'i-1'), 30)).toEqual({ serverId: 's1', status: 'STOPPING' });
      expect(servers.get('s1')).toMatchObject({ status: 'STOPPING', stopReason: 'no players for 30 minutes' });
      expect(started[0]?.workflow).toBe('stop');
    });

    it('says "1 minute"', async () => {
      const { store, servers } = fakeStore([server({ status: 'RUNNING' })]);
      await ops(store).idleStop(agent('s1', 'i-1'), 1);
      expect(servers.get('s1')?.stopReason).toBe('no players for 1 minute');
    });

    it.each(['STOPPED', 'STOPPING'] as const)('does nothing when already %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      expect((await ops(store).idleStop(agent('s1', 'i-1'), 30)).unchanged).toBe(true);
      expect(started).toEqual([]);
    });

    it.each(['STARTING', 'FAILED', 'PROVISIONING'] as const)('refuses a %s server', async (status) => {
      const { store } = fakeStore([server({ status })]);
      await expect(ops(store).idleStop(agent('s1', 'i-1'), 30)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses when the server is on another instance', async () => {
      const { store } = fakeStore([server({ status: 'RUNNING' })]);
      await expect(ops(store).idleStop(agent('s1', 'i-2'), 30)).rejects.toThrow(/no longer on instance i-2/);
      expect(started).toEqual([]);
    });
  });

  describe('set version', () => {
    // Started, then stopped cleanly with a backup: ready to upgrade.
    const backedUp = {
      version: '26.1',
      lastStopClean: true,
      lastStartedAt: '2026-10-05T05:00:00Z',
      lastBackupAt: '2026-10-05T05:06:53.151Z',
    };

    it('moves a stopped, backed-up server to a newer release', async () => {
      const { store, servers } = fakeStore([server(backedUp)]);
      expect((await ops(store).setVersion(ADMIN, 's1', { version: '26.3' })).version).toBe('26.3');
      expect(servers.get('s1')).toMatchObject({ status: 'STOPPED', version: '26.3' });
      expect(started).toEqual([]); // applies on the next start
    });

    it('does nothing when already on that version', async () => {
      const { store } = fakeStore([server({ ...backedUp, status: 'RUNNING' })]);
      expect((await ops(store).setVersion(ADMIN, 's1', { version: '26.1' })).version).toBe('26.1');
    });

    it.each([
      ['an older release', '1.21.4', 409, /only move forward/],
      ['an unknown version', '26.9', 400, /not a release/],
      ['a snapshot', '26.4-snapshot-2', 400, /not a release/],
    ])('refuses %s', async (_, version, statusCode, message) => {
      const { store } = fakeStore([server(backedUp)]);
      const err = await ops(store).setVersion(ADMIN, 's1', { version }).catch((e: OperationError) => e);
      expect(err).toMatchObject({ statusCode });
      expect(String(err)).toMatch(message);
    });

    it('refuses when the current version is not a known release', async () => {
      const { store } = fakeStore([server({ ...backedUp, version: '26.2-pre1' })]);
      await expect(ops(store).setVersion(ADMIN, 's1', { version: '26.3' })).rejects.toThrow(/isn't a known release/);
    });

    it.each(['RUNNING', 'STARTING', 'FAILED'] as const)('refuses while %s', async (status) => {
      const { store } = fakeStore([server({ ...backedUp, status })]);
      await expect(ops(store).setVersion(ADMIN, 's1', { version: '26.3' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it.each([
      ['no backup', { lastBackupAt: undefined }],
      ['a backup older than the last start', { lastBackupAt: '2026-10-05T04:59:59.999Z' }],
      ['an unclean last stop', { lastStopClean: false }],
    ])('refuses with %s', async (_, overrides) => {
      const { store } = fakeStore([server({ ...backedUp, ...overrides })]);
      await expect(ops(store).setVersion(ADMIN, 's1', { version: '26.3' })).rejects.toThrow(/no backup since it last ran/);
    });

    it('refuses games without a version list', async () => {
      const { store } = fakeStore([server(backedUp)]);
      const noList = serverOperations({
        store,
        workflows: { start: async () => {} },
        backups: { list: async () => [] },
        uploads: { status: async () => undefined, accepted: () => ({ bucket: 'uploads', key: 'k' }) },
        versions: { releases: async () => undefined },
        homeRegion: 'us-west-2',
        gameRegions: ['us-west-2'],
      });
      await expect(noList.setVersion(ADMIN, 's1', { version: '26.3' })).rejects.toThrow(/isn't supported/);
    });

    it.each([
      ['a missing version', {}],
      ['an unknown field', { version: '26.3', force: true }],
      ['a malformed version', { version: '26.3; rm -rf /' }],
    ])('returns 400 for %s', async (_, body) => {
      const { store } = fakeStore([server(backedUp)]);
      await expect(ops(store).setVersion(ADMIN, 's1', body)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('backups', () => {
    it('lists backups, or 404 for an unknown server', async () => {
      const { store } = fakeStore([server({})]);
      expect(await ops(store).listBackups(ADMIN, 's1')).toEqual({ backups: BACKUPS });
      await expect(ops(store).listBackups(ADMIN, 'nope')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('restore', () => {
    it('defaults to the newest backup and records when it was asked for', async () => {
      const { store, servers } = fakeStore([server({ lastStopClean: true })]);
      const result = await ops(store).requestRestore(ADMIN, 's1', {});
      expect(result).toMatchObject({ status: 'STOPPED', restoreKey: NEWEST, restoreRequestedAt: NOW.toISOString() });
      expect(servers.get('s1')?.restoreKey).toBe(NEWEST);
      expect(started).toEqual([]); // nothing runs until the next start
    });

    it('replaces a pending upload restore with a backup, and cancelling clears either', async () => {
      const pendingUpload = { restoreKey: `accepted/${ACCEPTED}.tar.gz`, restoreSource: 'upload' as const };
      const { store, servers } = fakeStore([server({ lastStopClean: true, ...pendingUpload })]);
      await ops(store).requestRestore(ADMIN, 's1', {});
      expect(servers.get('s1')).toMatchObject({ restoreKey: NEWEST });
      expect(servers.get('s1')).not.toHaveProperty('restoreSource'); // else the agent would look in the uploads bucket

      Object.assign(servers.get('s1')!, pendingUpload);
      await ops(store).cancelRestore(ADMIN, 's1');
      expect(servers.get('s1')).not.toHaveProperty('restoreKey');
      expect(servers.get('s1')).not.toHaveProperty('restoreSource');
    });

    it.each([OLDER, '20261004T120000Z.tar.gz'])('takes a chosen backup by key or file name (%s)', async (key) => {
      const { store } = fakeStore([server({})]);
      expect((await ops(store).requestRestore(ADMIN, 's1', { key })).restoreKey).toBe(OLDER);
    });

    it('returns 404 for a backup the server does not have', async () => {
      const { store } = fakeStore([server({})]);
      await expect(ops(store).requestRestore(ADMIN, 's1', { key: 'servers/s2/20261005T120000Z.tar.gz' })).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    it.each(['RUNNING', 'STARTING', 'STOPPING'] as const)('refuses while %s', async (status) => {
      const { store } = fakeStore([server({ status })]);
      await expect(ops(store).requestRestore(ADMIN, 's1', {})).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses after an unclean stop unless forced', async () => {
      const { store } = fakeStore([server({ lastStopClean: false })]);
      await expect(ops(store).requestRestore(ADMIN, 's1', {})).rejects.toThrow(/wasn't clean/);
      expect((await ops(store).requestRestore(ADMIN, 's1', { force: true })).restoreKey).toBe(NEWEST);
    });

    it('refuses when there are no backups', async () => {
      const { store } = fakeStore([server({ serverId: 's2' })]);
      await expect(ops(store).requestRestore(ADMIN, 's2', {})).rejects.toThrow(/no backups/);
    });

    it.each([
      ['an unknown field', { key: NEWEST, keep: 1 }],
      ['a non-string key', { key: 5 }],
      ['a non-boolean force', { force: 'yes' }],
      ['a non-object body', 'newest'],
    ])('returns 400 for %s', async (_, body) => {
      const { store } = fakeStore([server({})]);
      await expect(ops(store).requestRestore(ADMIN, 's1', body)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('cancels a pending restore, and cancelling none is a no-op', async () => {
      const { store, servers } = fakeStore([server({ restoreKey: NEWEST, restoreRequestedAt: NOW.toISOString() })]);
      const result = await ops(store).cancelRestore(ADMIN, 's1');
      expect(result.restoreKey).toBeUndefined();
      expect(servers.get('s1')).not.toHaveProperty('restoreRequestedAt');
      expect((await ops(store).cancelRestore(ADMIN, 's1')).restoreKey).toBeUndefined();
    });

    it('works on a FAILED server whose instance is stopped, keeping it FAILED', async () => {
      const { store, servers } = fakeStore([server({ status: 'FAILED', instanceState: 'stopped', restoreKey: OLDER })]);
      expect(await ops(store).requestRestore(ADMIN, 's1', { key: NEWEST })).toMatchObject({ status: 'FAILED', restoreKey: NEWEST });
      await ops(store).cancelRestore(ADMIN, 's1');
      expect(servers.get('s1')).toMatchObject({ status: 'FAILED' });
      expect(servers.get('s1')?.restoreKey).toBeUndefined();
    });

    it('refuses a FAILED server whose instance is still running', async () => {
      const { store } = fakeStore([server({ status: 'FAILED', instanceState: 'running', restoreKey: OLDER })]);
      await expect(ops(store).requestRestore(ADMIN, 's1', {})).rejects.toMatchObject({ statusCode: 409 });
      await expect(ops(store).cancelRestore(ADMIN, 's1')).rejects.toMatchObject({ statusCode: 409 });
    });

    it('refuses to cancel once the server is starting', async () => {
      const { store } = fakeStore([server({ status: 'STARTING', restoreKey: NEWEST })]);
      await expect(ops(store).cancelRestore(ADMIN, 's1')).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('for signed-in users', () => {
    // u1 owns s1, u2 is a member of it, u3 has no access. For listing: u1 also owns s2 (newer)
    // and s3 (destroyed), and has a row for s9, a server that's gone from the table.
    const rows: ServerAccessRecord[] = [
      { userId: 'u1', serverId: 's1', role: 'owner', addedAt: NOW.toISOString(), addedBy: 'u1' },
      { userId: 'u2', serverId: 's1', role: 'member', addedAt: NOW.toISOString(), addedBy: 'u1' },
      { userId: 'u1', serverId: 's2', role: 'owner', addedAt: NOW.toISOString(), addedBy: 'u1' },
      { userId: 'u1', serverId: 's3', role: 'owner', addedAt: NOW.toISOString(), addedBy: 'u1' },
      { userId: 'u1', serverId: 's9', role: 'owner', addedAt: NOW.toISOString(), addedBy: 'u1' },
    ];
    const access: OperationDeps['access'] = {
      getAccess: async (userId, serverId) => {
        if (serverId !== 's1') return undefined;
        return rows.find((r) => r.userId === userId && r.serverId === serverId);
      },
      listForUser: async (userId) => rows.filter((r) => r.userId === userId),
    };
    const owner: Actor = { kind: 'user', userId: 'u1' };
    const member: Actor = { kind: 'user', userId: 'u2' };
    const stranger: Actor = { kind: 'user', userId: 'u3' };

    describe('listing my servers', () => {
      const servers = () =>
        fakeStore([
          server({ serverId: 's1', createdAt: '2026-10-01T00:00:00.000Z' }),
          server({ serverId: 's2', createdAt: '2026-10-05T00:00:00.000Z' }),
          server({ serverId: 's3', status: 'DESTROYED', createdAt: '2026-10-03T00:00:00.000Z' }),
        ]).store;

      it('lists the servers I own or am a member of, newest first, with my role on each', async () => {
        const mine = await ops(servers(), access).listMyServers(owner);
        expect(mine.map((m) => [m.server.serverId, m.relation])).toEqual([
          ['s2', 'owner'],
          ['s1', 'owner'],
        ]);
        const theirs = await ops(servers(), access).listMyServers(member);
        expect(theirs.map((m) => [m.server.serverId, m.relation])).toEqual([['s1', 'member']]);
      });

      it('shows destroyed servers only when asked, and skips rows whose server is gone', async () => {
        const all = await ops(servers(), access).listMyServers(owner, true);
        expect(all.map((m) => m.server.serverId)).toEqual(['s2', 's3', 's1']);
      });

      it('lists nothing for someone with no access, and refuses agents', async () => {
        expect(await ops(servers(), access).listMyServers(stranger)).toEqual([]);
        await expect(ops(servers(), access).listMyServers(agent('s1', 'i-1'))).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    it('lets a member start and stop the server', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      expect(await ops(store, access).startServer(member, 's1')).toEqual({ serverId: 's1', status: 'STARTING' });
      servers.get('s1')!.status = 'RUNNING';
      expect(await ops(store, access).stopServer(member, 's1')).toEqual({ serverId: 's1', status: 'STOPPING' });
    });

    it("refuses a member the owner's actions with 403, before changing anything", async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED' })]);
      const o = ops(store, access);
      for (const attempt of [
        o.destroyServer(member, 's1'),
        o.updateSettings(member, 's1', { idleStopMinutes: 5 }),
        o.setVersion(member, 's1', { version: '26.3' }),
        o.listBackups(member, 's1'),
        o.requestRestore(member, 's1', {}),
        o.cancelRestore(member, 's1'),
      ]) {
        await expect(attempt).rejects.toMatchObject({ statusCode: 403 });
      }
      expect(servers.get('s1')).toMatchObject({ status: 'STOPPED', version: '1.21.4' });
      expect(started).toEqual([]);
    });

    it('lets the owner destroy and change settings', async () => {
      const { store } = fakeStore([server({ status: 'STOPPED' })]);
      expect((await ops(store, access).destroyServer(owner, 's1')).status).toBe('DESTROYING');
      const { store: other } = fakeStore([server({ status: 'STOPPED' })]);
      expect((await ops(other, access).updateSettings(owner, 's1', { idleStopMinutes: 5 })).idleStopMinutes).toBe(5);
    });

    it('answers a stranger 404, exactly as for a server that does not exist', async () => {
      const { store } = fakeStore([server({ status: 'STOPPED' })]);
      const o = ops(store, access);
      await expect(o.getServer(stranger, 's1')).rejects.toMatchObject({ statusCode: 404, message: 'No server s1' });
      await expect(o.startServer(stranger, 's1')).rejects.toMatchObject({ statusCode: 404, message: 'No server s1' });
      await expect(o.getServer(owner, 'nope')).rejects.toMatchObject({ statusCode: 404, message: 'No server nope' });
    });

    it('returns the server with the caller’s relation, for shaping', async () => {
      const { store } = fakeStore([server({})]);
      expect((await ops(store, access).getServer(member, 's1')).relation).toBe('member');
      expect((await ops(store).getServer(ADMIN, 's1')).relation).toBe('admin');
    });

    it('lets only admins turn idle stop off: a server that never idles bills until stopped', async () => {
      const { store, servers } = fakeStore([server({ status: 'STOPPED', idleStopMinutes: 30 })]);
      await expect(ops(store, access).updateSettings(owner, 's1', { idleStopMinutes: 0 })).rejects.toMatchObject({
        statusCode: 403,
        message: 'Only Hearth admins can turn idle stop off; choose 1 to 1440 minutes',
      });
      expect(servers.get('s1')?.idleStopMinutes).toBe(30);
      expect((await ops(store, access).updateSettings(owner, 's1', { idleStopMinutes: 1440 })).idleStopMinutes).toBe(1440);
      expect((await ops(store).updateSettings(ADMIN, 's1', { idleStopMinutes: 0 })).idleStopMinutes).toBe(0);
    });

    it('keeps agent channels for admins, even from the owner', async () => {
      const { store } = fakeStore([server({ status: 'STOPPED' })]);
      await expect(ops(store, access).updateSettings(owner, 's1', { agentChannel: 'canary' })).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('keeps listing every server for admins', async () => {
      const { store } = fakeStore([server({})]);
      await expect(ops(store, access).listServers(owner, undefined, undefined)).rejects.toMatchObject({ statusCode: 403 });
    });

    describe('creating', () => {
      const body = { game: 'minecraft-java', version: '26.3' };
      // u1 is approved (limit 3); u2 isn't; u9 has never signed in.
      const users: OperationDeps['users'] = {
        getUser: async (userId) =>
          ({
            u1: { userId: 'u1', approved: true, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then' },
            u2: { userId: 'u2', approved: false, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then' },
          })[userId],
      };
      const setup = (existing: ServerRecord[] = []) => {
        const { store, servers } = fakeStore(existing);
        const owned: { serverId: string; userId: string; role: string }[] = [];
        const ownership: OperationDeps['ownership'] = {
          createOwnedServer: async (record, ownerRow) => {
            await store.createServer(record);
            owned.push(ownerRow);
          },
        };
        return { o: ops(store, access, { users, ownership }), servers, owned };
      };

      it('lets an approved user create a server they own, with their owner row', async () => {
        const { o, servers, owned } = setup();
        expect(await o.createServer(owner, body)).toEqual({ serverId: 'ID1', status: 'PROVISIONING' });
        expect(servers.get('ID1')).toMatchObject({ ownerId: 'u1', agentChannel: 'stable', status: 'PROVISIONING' });
        expect(owned).toEqual([expect.objectContaining({ serverId: 'ID1', userId: 'u1', role: 'owner', addedBy: 'u1' })]);
        expect(started).toEqual([{ workflow: 'create', serverId: 'ID1', operationId: 'ID2' }]);
      });

      it("creates from the user's own upload; anyone else's is 404, as if it didn't exist", async () => {
        const { o, servers } = setup();
        await o.createServer(owner, { ...body, upload: ACCEPTED });
        expect(servers.get('ID1')?.restoreKey).toBe(`accepted/${ACCEPTED}.tar.gz`);
        await expect(o.createServer(owner, { ...body, upload: OLD_ACCEPTED })).rejects.toMatchObject({
          statusCode: 404,
          message: `No upload ${OLD_ACCEPTED} (never uploaded, or expired)`,
        });
        expect(servers.size).toBe(1);
      });

      it('refuses a user an admin has not approved, or who never signed in, with 403', async () => {
        const { o, servers } = setup();
        await expect(o.createServer(member, body)).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/approves/) });
        await expect(o.createServer({ kind: 'user', userId: 'u9' }, body)).rejects.toMatchObject({ statusCode: 403 });
        expect(servers.size).toBe(0);
        expect(started).toEqual([]);
      });

      it('refuses a user at their limit; destroyed servers do not count', async () => {
        const mine = (id: string, status: ServerRecord['status'] = 'STOPPED') => server({ serverId: id, ownerId: 'u1', status });
        const full = setup([mine('a'), mine('b'), mine('c')]);
        await expect(full.o.createServer(owner, body)).rejects.toMatchObject({
          statusCode: 403,
          message: 'You have 3 servers, your limit; destroy one to create another',
        });
        const freed = setup([mine('a'), mine('b'), mine('c', 'DESTROYED')]);
        expect((await freed.o.createServer(owner, body)).status).toBe('PROVISIONING');
      });

      it('keeps the agent channel for admins, and lets admins past approval and the limit', async () => {
        const { o } = setup();
        await expect(o.createServer(owner, { ...body, agentChannel: 'canary' })).rejects.toMatchObject({ statusCode: 403 });
        const admin: Actor = { kind: 'admin', id: 'u2' }; // not approved as a user: admins need no approval
        expect((await o.createServer(admin, { ...body, agentChannel: 'canary' })).status).toBe('PROVISIONING');
      });

      it('refuses agents', async () => {
        const { o } = setup();
        await expect(o.createServer(agent('s1', 'i-1'), body)).rejects.toMatchObject({ statusCode: 403 });
      });
    });

    it('lets an agent stop only its own server', async () => {
      const { store } = fakeStore([server({ status: 'RUNNING' }), server({ serverId: 's2', status: 'RUNNING', instanceId: 'i-2' })]);
      await expect(ops(store).idleStop(agent('s2', 'i-1'), 30)).rejects.toMatchObject({ statusCode: 409 });
      await expect(ops(store).startServer(agent('s1', 'i-1'), 's1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
