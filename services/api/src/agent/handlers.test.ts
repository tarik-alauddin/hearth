import type { APIGatewayProxyEventV2WithIAMAuthorizer } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentStatusReport, ServerRecord } from '@hearth/shared';
import type { ServersStore } from '../servers.js';
import { agentHandlers } from './handlers.js';

const ROLE = 'hearth-dev-InstanceRole';
const INSTANCE = 'i-0123456789abcdef0';
const NOW = new Date('2026-09-28T12:00:00Z');

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
  const store: ServersStore = {
    findByInstance: async (instanceId) => servers.find((s) => s.instanceId === instanceId),
    recordAgentReport: async (serverId, instanceId, report, at) => {
      if (servers.find((s) => s.serverId === serverId)?.instanceId !== instanceId) return false;
      reports.push({ serverId, instanceId, report, at });
      return true;
    },
  };
  return { store, reports };
}

describe('agent handlers', () => {
  let store: ReturnType<typeof fakeStore>;
  let handlers: ReturnType<typeof agentHandlers>;

  beforeEach(() => {
    store = fakeStore([server]);
    handlers = agentHandlers({ store: store.store, instanceRoleNames: [ROLE], now: () => NOW });
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
      const h = agentHandlers({ store: moved.store, instanceRoleNames: [ROLE], now: () => NOW });
      const res = await h.status(event({ body: body({ state: 'ready', agentVersion: '0.1.0' }) }));
      expect(res.statusCode).toBe(409);
    });
  });
});
