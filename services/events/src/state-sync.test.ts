import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanceState, ServerRecord, ServerStatus } from '@hearth/shared';
import { RetryLater, stateSync, type Ec2StateChange, type InstanceInfo, type StateSyncDeps } from './state-sync.js';

const INSTANCE = 'i-0123456789abcdef0';

function event(state: string, time = '2026-09-29T12:00:00Z', instanceId = INSTANCE): Ec2StateChange {
  return {
    id: 'e1',
    version: '0',
    account: '138300868928',
    time,
    region: 'us-west-2',
    resources: [],
    source: 'aws.ec2',
    'detail-type': 'EC2 Instance State-change Notification',
    detail: { 'instance-id': instanceId, state },
  };
}

/** An in-memory Servers table holding one server, with the store's conditional rules. */
function fakeStore(status: ServerStatus) {
  const server: ServerRecord & { instanceStateAt?: string } = {
    serverId: 's1',
    ownerId: 'o',
    game: 'minecraft-java',
    region: 'us-west-2',
    status,
    version: '1.21.4',
    autoUpdate: false,
    instanceId: INSTANCE,
  };
  const store: StateSyncDeps['store'] = {
    findByInstance: async (id) => (id === server.instanceId ? server : undefined),
    recordInstanceState: async (serverId, instanceId, state: InstanceState, at) => {
      if (instanceId !== server.instanceId) return false;
      if (server.instanceStateAt && server.instanceStateAt >= at.toISOString()) return false;
      server.instanceState = state;
      server.instanceStateAt = at.toISOString();
      if (state !== 'running') delete server.publicIp;
      return true;
    },
    transition: async (_, { from, to }) => {
      if (!from.includes(server.status)) return false;
      server.status = to;
      return true;
    },
  };
  return { server, store };
}

describe('state sync', () => {
  let instances: Record<string, InstanceInfo>;
  let described: string[];
  const deps = (store: StateSyncDeps['store']): StateSyncDeps => ({
    env: 'dev',
    store,
    describeInstance: async (_, id) => {
      described.push(id);
      return instances[id];
    },
    log: () => {},
  });

  beforeEach(() => {
    instances = { [INSTANCE]: { tags: { app: 'hearth', env: 'dev' } } };
    described = [];
  });

  it('records a running instance without asking EC2, keeping the IP the workflow recorded', async () => {
    const { server, store } = fakeStore('STARTING');
    server.publicIp = '35.1.2.3';
    await stateSync(deps(store))(event('running'));
    expect(server.instanceState).toBe('running');
    expect(server.publicIp).toBe('35.1.2.3');
    expect(server.status).toBe('STARTING'); // the start workflow sets RUNNING once the game is ready
    expect(described).toEqual([]);
  });

  it('marks a running server stopped when its instance stops outside the stop workflow', async () => {
    const { server, store } = fakeStore('RUNNING');
    server.publicIp = '35.1.2.3';
    await stateSync(deps(store))(event('running', '2026-09-29T12:00:00Z'));
    await stateSync(deps(store))(event('stopped', '2026-09-29T13:00:00Z'));
    expect(server.status).toBe('STOPPED');
    expect(server.instanceState).toBe('stopped');
    expect(server.publicIp).toBeUndefined();
  });

  it('leaves a stop in progress to the stop workflow', async () => {
    const { server, store } = fakeStore('STOPPING');
    await stateSync(deps(store))(event('stopped'));
    expect(server.instanceState).toBe('stopped');
    expect(server.status).toBe('STOPPING');
  });

  it('ignores an event older than the recorded state', async () => {
    const { server, store } = fakeStore('RUNNING');
    await stateSync(deps(store))(event('running', '2026-09-29T13:00:00Z'));
    await stateSync(deps(store))(event('stopped', '2026-09-29T12:00:00Z')); // delivered late
    expect(server.instanceState).toBe('running');
    expect(server.status).toBe('RUNNING');
  });

  it('ignores instances of other environments and projects', async () => {
    const { store } = fakeStore('RUNNING');
    instances['i-other'] = { tags: { app: 'hearth', env: 'prod' } };
    instances['i-unrelated'] = { tags: {} };
    await expect(stateSync(deps(store))(event('running', undefined, 'i-other'))).resolves.toBeUndefined();
    await expect(stateSync(deps(store))(event('running', undefined, 'i-unrelated'))).resolves.toBeUndefined();
    await expect(stateSync(deps(store))(event('running', undefined, 'i-gone'))).resolves.toBeUndefined();
  });

  it('only asks EC2 about unknown instances when they start running', async () => {
    const { store } = fakeStore('RUNNING');
    instances['i-other'] = { tags: {} };
    await stateSync(deps(store))(event('stopped', undefined, 'i-other'));
    await stateSync(deps(store))(event('terminated', undefined, 'i-other'));
    expect(described).toEqual([]);
    await stateSync(deps(store))(event('running', undefined, 'i-other'));
    expect(described).toEqual(['i-other']);
  });

  it('retries an instance of this environment whose record is not written yet', async () => {
    const { store } = fakeStore('PROVISIONING');
    instances['i-new'] = { tags: { app: 'hearth', env: 'dev' } };
    await expect(stateSync(deps(store))(event('running', undefined, 'i-new'))).rejects.toBeInstanceOf(RetryLater);
  });

  it('ignores states EC2 might add later', async () => {
    const { server, store } = fakeStore('RUNNING');
    await stateSync(deps(store))(event('hibernating'));
    expect(server.instanceState).toBeUndefined();
  });
});
