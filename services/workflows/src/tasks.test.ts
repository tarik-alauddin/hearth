import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerRecord } from '@hearth/shared';
import {
  AgentError,
  CapacityError,
  NotReady,
  failureMessage,
  workflowTasks,
  type Ec2,
  type InstanceInfo,
  type TaskDeps,
} from './tasks.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const LATER = '2026-09-29T12:05:00.000Z';
const EARLIER = '2026-09-29T11:00:00.000Z';

function newServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    serverId: 's1',
    ownerId: 'o',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'PROVISIONING',
    version: '1.21.4',
    autoUpdate: false,
    ...overrides,
  };
}

/** One server in memory, with the store's conditional transition rules. */
function fakeStore(server: ServerRecord): TaskDeps['store'] {
  return {
    getServer: async (id) => (id === server.serverId ? { ...server } : undefined),
    transition: async (_, { from, to, instanceId, set = {}, remove = [] }) => {
      if (!from.includes(server.status)) return false;
      if (instanceId !== undefined && server.instanceId !== instanceId) return false;
      Object.assign(server, set, { status: to });
      for (const field of remove) delete server[field];
      return true;
    },
  };
}

class FakeEc2 implements Ec2 {
  calls: string[] = [];
  instances: Record<string, InstanceInfo> = {};
  tags: Record<string, Record<string, string>> = {};
  noCapacityIn = new Set<string>();

  async runInstance(_: string, { subnetId, clientToken }: { subnetId: string; clientToken: string }) {
    this.calls.push(`run ${subnetId} ${clientToken}`);
    if (this.noCapacityIn.has(subnetId)) throw new CapacityError('none');
    this.instances['i-new'] = { state: 'pending', volumes: {} };
    return 'i-new';
  }
  async describeInstance(_: string, id: string) {
    return this.instances[id];
  }
  async createTags(_: string, ids: string[], tags: Record<string, string>) {
    for (const id of ids) this.tags[id] = { ...this.tags[id], ...tags };
  }
  async startInstance(_: string, id: string) {
    this.calls.push(`start ${id}`);
  }
  async stopInstance(_: string, id: string) {
    this.calls.push(`stop ${id}`);
  }
}

const GAME_INFRA = {
  'us-west-2': {
    subnetIds: ['subnet-a', 'subnet-b', 'subnet-c'],
    launchTemplates: { 'minecraft-java': { id: 'lt-1', version: '7' } },
  },
};

describe('workflow tasks', () => {
  let server: ServerRecord;
  let ec2: FakeEc2;
  let tasks: ReturnType<typeof workflowTasks>;

  const setup = (overrides: Partial<ServerRecord> = {}) => {
    server = newServer(overrides);
    ec2 = new FakeEc2();
    tasks = workflowTasks({ env: 'dev', store: fakeStore(server), ec2, gameInfra: GAME_INFRA, now: () => NOW });
  };
  beforeEach(() => setup());

  describe('create', () => {
    it('launches from the pinned template, tags the instance and moves to STARTING', async () => {
      const out = await tasks.launchInstance({ serverId: 's1' });
      expect(out).toEqual({ serverId: 's1', since: NOW.toISOString() });
      expect(ec2.calls).toEqual(['run subnet-a s1-0']);
      expect(ec2.tags['i-new']).toEqual({ serverId: 's1', Name: 'hearth-dev-s1' });
      expect(server).toMatchObject({ status: 'STARTING', instanceId: 'i-new' });
    });

    it('tries the next AZ when one is out of capacity', async () => {
      ec2.noCapacityIn.add('subnet-a');
      await tasks.launchInstance({ serverId: 's1' });
      expect(ec2.calls).toEqual(['run subnet-a s1-0', 'run subnet-b s1-1']);
    });

    it('throws CapacityError when every AZ is full, so the workflow retries later', async () => {
      ['subnet-a', 'subnet-b', 'subnet-c'].forEach((s) => ec2.noCapacityIn.add(s));
      await expect(tasks.launchInstance({ serverId: 's1' })).rejects.toBeInstanceOf(CapacityError);
      expect(server.status).toBe('PROVISIONING');
    });

    it('refuses to launch for a server that is not PROVISIONING', async () => {
      setup({ status: 'RUNNING' });
      await expect(tasks.launchInstance({ serverId: 's1' })).rejects.toThrow('expected PROVISIONING');
      expect(ec2.calls).toEqual([]);
    });

    it('records and tags the world volume once the instance runs', async () => {
      await tasks.launchInstance({ serverId: 's1' });
      await expect(tasks.recordVolume({ serverId: 's1' })).rejects.toBeInstanceOf(NotReady);
      ec2.instances['i-new'] = { state: 'running', volumes: { '/dev/xvda': 'vol-root', '/dev/sdf': 'vol-world' } };
      await tasks.recordVolume({ serverId: 's1' });
      expect(server.volumeId).toBe('vol-world');
      expect(ec2.tags['vol-world']).toEqual({ serverId: 's1' });
      expect(ec2.tags['vol-root']).toBeUndefined();
    });
  });

  describe('start', () => {
    beforeEach(() => setup({ status: 'STARTING', instanceId: 'i-1', agentState: 'stopped', agentReportedAt: EARLIER }));

    it('starts the instance and remembers when', async () => {
      expect(await tasks.startInstance({ serverId: 's1' })).toEqual({ serverId: 's1', since: NOW.toISOString() });
      expect(ec2.calls).toEqual(['start i-1']);
    });

    it('waits for a ready report from this boot, ignoring older reports', async () => {
      const state = { serverId: 's1', since: NOW.toISOString() };
      await expect(tasks.waitForAgent(state)).rejects.toBeInstanceOf(NotReady);
      Object.assign(server, { agentState: 'ready', agentReportedAt: EARLIER });
      await expect(tasks.waitForAgent(state)).rejects.toBeInstanceOf(NotReady);
      Object.assign(server, { agentState: 'ready', agentReportedAt: LATER });
      await expect(tasks.waitForAgent(state)).resolves.toEqual(state);
    });

    it('fails fast when the agent reports an error', async () => {
      Object.assign(server, { agentState: 'error', agentReportedAt: LATER, agentMessage: 'image pull failed' });
      await expect(tasks.waitForAgent({ serverId: 's1', since: NOW.toISOString() })).rejects.toThrow(AgentError);
    });

    it('marks the server RUNNING', async () => {
      await tasks.markRunning({ serverId: 's1' });
      expect(server.status).toBe('RUNNING');
    });
  });

  describe('stop', () => {
    beforeEach(() => setup({ status: 'STOPPING', instanceId: 'i-1', agentState: 'ready', agentReportedAt: EARLIER }));

    it('stops the instance and waits until EC2 says stopped', async () => {
      await tasks.stopInstance({ serverId: 's1' });
      expect(ec2.calls).toEqual(['stop i-1']);
      ec2.instances['i-1'] = { state: 'stopping', volumes: {} };
      await expect(tasks.waitForStopped({ serverId: 's1' })).rejects.toBeInstanceOf(NotReady);
      ec2.instances['i-1'] = { state: 'stopped', volumes: {} };
      await expect(tasks.waitForStopped({ serverId: 's1' })).resolves.toBeDefined();
    });

    it('records a clean stop when the agent reported stopped during this stop', async () => {
      Object.assign(server, { agentState: 'stopped', agentReportedAt: LATER });
      await tasks.markStopped({ serverId: 's1', since: NOW.toISOString() });
      expect(server).toMatchObject({ status: 'STOPPED', lastStopClean: true });
    });

    it('records an unclean stop when the agent never reported stopping', async () => {
      await tasks.markStopped({ serverId: 's1', since: NOW.toISOString() });
      expect(server).toMatchObject({ status: 'STOPPED', lastStopClean: false });
    });
  });

  describe('failure', () => {
    it('marks an in-progress server FAILED with the reason', async () => {
      setup({ status: 'STARTING', instanceId: 'i-1' });
      await tasks.markFailed({
        serverId: 's1',
        error: { Error: 'AgentError', Cause: JSON.stringify({ errorMessage: 'image pull failed' }) },
      });
      expect(server).toMatchObject({ status: 'FAILED', statusMessage: 'AgentError: image pull failed' });
    });

    it('leaves a server alone if it already moved on', async () => {
      setup({ status: 'RUNNING' });
      await tasks.markFailed({ serverId: 's1', error: { Error: 'States.Timeout' } });
      expect(server.status).toBe('RUNNING');
    });

    it('formats plain-text causes', () => {
      expect(failureMessage({ Error: 'States.Timeout', Cause: 'took too long' })).toBe('States.Timeout: took too long');
      expect(failureMessage(undefined)).toBe('Unknown failure');
    });
  });
});
