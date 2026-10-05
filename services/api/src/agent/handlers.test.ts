import type { APIGatewayProxyEventV2WithIAMAuthorizer } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentStatusReport, ServerRecord } from '@hearth/shared';
import type { BackupStorage } from './backups.js';
import { agentHandlers, type AgentHandlerDeps } from './handlers.js';
import type { AgentReleases } from './releases.js';

const ROLE = 'hearth-dev-InstanceRole';
const INSTANCE = 'i-0123456789abcdef0';
const NOW = new Date('2026-09-28T12:00:00Z');
const noReleases: AgentReleases = { target: async () => undefined };
const BACKUP_KEY = 'servers/01K6ABCDEF0123456789ABCDEF/20260928T120000Z.tar.gz';

/** A bucket holding the given objects (key → size), handing out fake credentials. */
function fakeBackups(objects: Record<string, number> = {}): BackupStorage {
  return {
    target: async (_serverId, key) => ({
      bucket: 'backups',
      key,
      region: 'us-west-2',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 's', sessionToken: 't', expiration: '2026-09-28T12:15:00.000Z' },
    }),
    size: async (key) => objects[key],
    list: async () => [],
    prune: async () => [],
  };
}

const server: ServerRecord = {
  serverId: '01K6ABCDEF0123456789ABCDEF',
  ownerId: 'owner',
  game: 'minecraft-java',
  region: 'us-west-2',
  status: 'RUNNING',
  version: '1.21.4',
  autoUpdate: false,
  instanceId: INSTANCE,
};

function event(opts: { role?: string; instance?: string; body?: string } = {}) {
  const userArn = `arn:aws:sts::138300868928:assumed-role/${opts.role ?? ROLE}/${opts.instance ?? INSTANCE}`;
  return {
    requestContext: { authorizer: { iam: { userArn } } },
    body: opts.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithIAMAuthorizer;
}

function fakeStore(servers: ServerRecord[]) {
  const reports: { serverId: string; instanceId: string; report: AgentStatusReport; at: Date }[] = [];
  const backups: { serverId: string; instanceId: string; key: string; bytes: number; at: Date }[] = [];
  const onInstance = (serverId: string, instanceId: string) =>
    servers.find((s) => s.serverId === serverId)?.instanceId === instanceId;
  const store: AgentHandlerDeps['store'] = {
    findByInstance: async (instanceId) => servers.find((s) => s.instanceId === instanceId),
    recordAgentReport: async (serverId, instanceId, report, at) => {
      if (!onInstance(serverId, instanceId)) return false;
      reports.push({ serverId, instanceId, report, at });
      return true;
    },
    recordBackup: async (serverId, instanceId, { key, bytes }, at) => {
      if (!onInstance(serverId, instanceId)) return false;
      backups.push({ serverId, instanceId, key, bytes, at });
      return true;
    },
  };
  return { store, reports, backups };
}

describe('agent handlers', () => {
  let store: ReturnType<typeof fakeStore>;
  let handlers: ReturnType<typeof agentHandlers>;
  const deps = { instanceRoleNames: [ROLE], releases: noReleases, backups: fakeBackups(), now: () => NOW };

  beforeEach(() => {
    store = fakeStore([server]);
    handlers = agentHandlers({ ...deps, store: store.store });
  });

  describe('GET /agent/config', () => {
    it('returns the calling instance’s server config', async () => {
      const res = await handlers.config(event());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        serverId: server.serverId,
        game: 'minecraft-java',
        version: '1.21.4',
        image: 'docker.io/itzg/minecraft-server',
        port: 25565,
      });
    });

    it('rejects callers that are not game instances', async () => {
      expect((await handlers.config(event({ role: 'github-deploy' }))).statusCode).toBe(403);
    });

    it("includes the agent release for the server's channel", async () => {
      const channels: string[] = [];
      const releases: AgentReleases = {
        target: async (channel) => {
          channels.push(channel);
          return channel === 'canary' ? { version: '1.3.0', sha256: 'abc', url: 's3://b/agent/1.3.0/x' } : undefined;
        },
      };
      const onCanary = fakeStore([{ ...server, agentChannel: 'canary' }]);
      const res = await agentHandlers({ ...deps, store: onCanary.store, releases }).config(event());
      expect(JSON.parse(res.body!).agent).toEqual({ version: '1.3.0', sha256: 'abc', url: 's3://b/agent/1.3.0/x' });

      const onStable = fakeStore([server]); // no channel set: stable
      const res2 = await agentHandlers({ ...deps, store: onStable.store, releases }).config(event());
      expect(JSON.parse(res2.body!).agent).toBeUndefined();
      expect(channels).toEqual(['canary', 'stable']);
    });

    it('returns 404 when no server is on the instance', async () => {
      expect((await handlers.config(event({ instance: 'i-0fffffffffffffff0' }))).statusCode).toBe(404);
    });
  });

  describe('POST /agent/status', () => {
    const body = (report: unknown) => JSON.stringify(report);

    it('records the report', async () => {
      const res = await handlers.status(event({ body: body({ state: 'ready', agentVersion: '0.1.0' }) }));
      expect(res.statusCode).toBe(204);
      expect(store.reports).toEqual([
        { serverId: server.serverId, instanceId: INSTANCE, report: { state: 'ready', agentVersion: '0.1.0' }, at: NOW },
      ]);
    });

    it('keeps an optional message', async () => {
      await handlers.status(event({ body: body({ state: 'error', agentVersion: '0.1.0', message: 'boom' }) }));
      expect(store.reports[0]?.report.message).toBe('boom');
    });

    it.each([
      ['not JSON', 'nope'],
      ['no body', undefined],
      ['an unknown state', body({ state: 'dancing', agentVersion: '0.1.0' })],
      ['a missing agentVersion', body({ state: 'ready' })],
      ['a non-string message', body({ state: 'ready', agentVersion: '0.1.0', message: 42 })],
      ['a too-long message', body({ state: 'ready', agentVersion: '0.1.0', message: 'x'.repeat(501) })],
    ])('returns 400 for %s', async (_, raw) => {
      expect((await handlers.status(event({ body: raw }))).statusCode).toBe(400);
      expect(store.reports).toHaveLength(0);
    });

    it('rejects callers that are not game instances', async () => {
      const res = await handlers.status(event({ role: 'github-deploy', body: body({ state: 'ready', agentVersion: '1' }) }));
      expect(res.statusCode).toBe(403);
    });

    it('returns 409 when the server moved to another instance', async () => {
      const moved = fakeStore([server]);
      moved.store.recordAgentReport = async () => false;
      const h = agentHandlers({ ...deps, store: moved.store });
      const res = await h.status(event({ body: body({ state: 'ready', agentVersion: '0.1.0' }) }));
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /agent/backup-credentials', () => {
    it("returns a key under the caller's server, named by time, with credentials for it", async () => {
      const keys: string[] = [];
      const backups = fakeBackups();
      const h = agentHandlers({
        ...deps,
        store: store.store,
        backups: { ...backups, target: async (serverId, key) => (keys.push(`${serverId} ${key}`), backups.target(serverId, key)) },
      });
      const res = await h.backupCredentials(event());
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ bucket: 'backups', key: BACKUP_KEY, credentials: { sessionToken: 't' } });
      expect(keys).toEqual([`${server.serverId} ${BACKUP_KEY}`]);
    });

    it('rejects callers that are not game instances', async () => {
      expect((await handlers.backupCredentials(event({ role: 'github-deploy' }))).statusCode).toBe(403);
    });
  });

  describe('POST /agent/backups', () => {
    const done = (key: unknown) => event({ body: JSON.stringify({ key }) });

    it('records the uploaded backup with its size from S3', async () => {
      const h = agentHandlers({ ...deps, store: store.store, backups: fakeBackups({ [BACKUP_KEY]: 4096 }) });
      expect((await h.backupDone(done(BACKUP_KEY))).statusCode).toBe(204);
      expect(store.backups).toEqual([{ serverId: server.serverId, instanceId: INSTANCE, key: BACKUP_KEY, bytes: 4096, at: NOW }]);
    });

    it.each([
      ['a missing key', undefined],
      ["another server's key", 'servers/01OTHER/20260928T120000Z.tar.gz'],
      ['a key in the wrong format', `servers/${server.serverId}/latest.tar.gz`],
      ['a key with no object', BACKUP_KEY],
    ])('returns 400 for %s', async (_, key) => {
      expect((await handlers.backupDone(done(key))).statusCode).toBe(400);
      expect(store.backups).toHaveLength(0);
    });

    it("prunes the server's old backups after recording, keeping 10", async () => {
      const calls: string[] = [];
      const backups = { ...fakeBackups({ [BACKUP_KEY]: 1 }), prune: async (id: string, keep: number) => (calls.push(`${id} ${keep}`), []) };
      const h = agentHandlers({ ...deps, store: store.store, backups });
      expect((await h.backupDone(done(BACKUP_KEY))).statusCode).toBe(204);
      expect(calls).toEqual([`${server.serverId} 10`]);
    });

    it('still records the backup when pruning fails', async () => {
      const backups = { ...fakeBackups({ [BACKUP_KEY]: 1 }), prune: async () => Promise.reject(new Error('S3 down')) };
      const h = agentHandlers({ ...deps, store: store.store, backups });
      expect((await h.backupDone(done(BACKUP_KEY))).statusCode).toBe(204);
      expect(store.backups).toHaveLength(1);
    });

    it('returns 409 when the server moved to another instance', async () => {
      const moved = fakeStore([server]);
      moved.store.recordBackup = async () => false;
      const h = agentHandlers({ ...deps, store: moved.store, backups: fakeBackups({ [BACKUP_KEY]: 1 }) });
      expect((await h.backupDone(done(BACKUP_KEY))).statusCode).toBe(409);
    });
  });
});
