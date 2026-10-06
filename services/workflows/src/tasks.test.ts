import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerRecord } from '@hearth/shared';
import {
  AgentError,
  AgentStopFailed,
  CapacityError,
  NotReady,
  failureMessage,
  workflowTasks,
  type CommandStatus,
  type Ec2,
  type Ssm,
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

  async runInstance(
    _: string,
    { subnetId, clientToken, tags }: { subnetId: string; clientToken: string; tags: Record<string, string> },
  ) {
    this.calls.push(`run ${subnetId} ${clientToken}`);
    if (this.noCapacityIn.has(subnetId)) throw new CapacityError('none');
    this.instances['i-new'] = { state: 'pending', volumes: {} };
    this.tags['i-new'] = tags;
    return 'i-new';
  }
  async findInstances(_: string, serverId: string) {
    return Object.entries(this.instances)
      .filter(([id]) => this.tags[id]?.serverId === serverId)
      .map(([instanceId, { state }]) => ({ instanceId, state }));
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

class FakeSsm implements Ssm {
  sent: string[] = [];
  cancelled: string[] = [];
  status: CommandStatus = 'pending';
  async sendCommand(_: string, { instanceId, documentName }: { instanceId: string; documentName: string }) {
    this.sent.push(`${documentName} ${instanceId}`);
    return 'cmd-1';
  }
  async commandStatus() {
    return this.status;
  }
  async cancelCommand(_: string, { commandId }: { commandId: string }) {
    this.cancelled.push(commandId);
  }
}

const GAME_INFRA = {
  'us-west-2': {
    subnetIds: ['subnet-a', 'subnet-b', 'subnet-c'],
    launchTemplates: { 'minecraft-java': { id: 'lt-1' } },
    stopAgentDocument: 'hearth-dev-stop-agent',
  },
};

describe('workflow tasks', () => {
  let server: ServerRecord;
  let ec2: FakeEc2;
  let ssm: FakeSsm;
  let tasks: ReturnType<typeof workflowTasks>;
  let recorded: { name: string; value: number; dimensions?: Record<string, string> }[];

  const setup = (overrides: Partial<ServerRecord> = {}) => {
    server = newServer(overrides);
    ec2 = new FakeEc2();
    ssm = new FakeSsm();
    recorded = [];
    tasks = workflowTasks({
      env: 'dev',
      store: fakeStore(server),
      ec2,
      ssm,
      gameInfra: GAME_INFRA,
      now: () => NOW,
      metrics: { record: (name, value, _unit, dimensions) => recorded.push({ name, value, dimensions }) },
    });
  };
  beforeEach(() => setup());

  describe('create', () => {
    it('launches from the template, tags the instance and moves to STARTING', async () => {
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

    it('records and tags the data volume once the instance runs', async () => {
      await tasks.launchInstance({ serverId: 's1' });
      await expect(tasks.recordVolume({ serverId: 's1' })).rejects.toBeInstanceOf(NotReady);
      ec2.instances['i-new'] = { state: 'running', volumes: { '/dev/xvda': 'vol-root', '/dev/sdf': 'vol-data' } };
      await tasks.recordVolume({ serverId: 's1' });
      expect(server.volumeId).toBe('vol-data');
      expect(ec2.tags['vol-data']).toEqual({ serverId: 's1' });
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

    it('records how long the server took to become ready, per workflow', async () => {
      await tasks.markRunning({ serverId: 's1', since: '2026-09-29T11:58:30.000Z' }, { workflow: 'start' });
      expect(recorded).toEqual([{ name: 'TimeToReady', value: 90, dimensions: { Workflow: 'start' } }]);
    });
  });

  describe('stop', () => {
    beforeEach(() => setup({ status: 'STOPPING', instanceId: 'i-1', agentState: 'ready', agentReportedAt: EARLIER }));

    it('stops the agent through Run Command before the instance, and waits for it', async () => {
      ec2.instances['i-1'] = { state: 'running', volumes: {} };
      const state = await tasks.stopAgent({ serverId: 's1' });
      expect(state).toEqual({ serverId: 's1', since: NOW.toISOString(), commandId: 'cmd-1' });
      expect(ssm.sent).toEqual(['hearth-dev-stop-agent i-1']);
      expect(ec2.calls).toEqual([]);
      await expect(tasks.waitForAgentStop(state)).rejects.toBeInstanceOf(NotReady);
      ssm.status = 'success';
      await expect(tasks.waitForAgentStop(state)).resolves.toEqual(state);
    });

    it('fails the agent stop when the command fails, so the workflow stops the instance anyway', async () => {
      ssm.status = 'failed';
      await expect(tasks.waitForAgentStop({ serverId: 's1', commandId: 'cmd-1' })).rejects.toBeInstanceOf(AgentStopFailed);
    });

    it('skips the agent when the instance is not running', async () => {
      ec2.instances['i-1'] = { state: 'stopped', volumes: {} };
      const state = await tasks.stopAgent({ serverId: 's1' });
      expect(ssm.sent).toEqual([]);
      await expect(tasks.waitForAgentStop(state)).resolves.toEqual(state);
    });

    it('cancels the agent stop command when giving up on it, so a later boot never receives it', async () => {
      await tasks.stopInstance({ serverId: 's1', since: EARLIER, commandId: 'cmd-1', agentStopError: { Error: 'NotReady' } });
      expect(ssm.cancelled).toEqual(['cmd-1']);
      expect(ec2.calls).toEqual(['stop i-1']);
    });

    it('stops the instance even if the cancel fails', async () => {
      ssm.cancelCommand = async () => {
        throw new Error('InvalidCommandId');
      };
      await tasks.stopInstance({ serverId: 's1', commandId: 'cmd-1', agentStopError: { Error: 'NotReady' } });
      expect(ec2.calls).toEqual(['stop i-1']);
    });

    it('leaves a finished agent stop command alone', async () => {
      await tasks.stopInstance({ serverId: 's1', since: EARLIER, commandId: 'cmd-1' });
      expect(ssm.cancelled).toEqual([]);
    });

    it("keeps the stop's start time, so the agent's earlier stopped report still counts", async () => {
      const out = await tasks.stopInstance({ serverId: 's1', since: EARLIER });
      expect(out.since).toBe(EARLIER);
    });

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
      expect(recorded).toEqual([{ name: 'StopClean', value: 1, dimensions: undefined }]);
    });

    it('records an unclean stop when the agent never reported stopping', async () => {
      await tasks.markStopped({ serverId: 's1', since: NOW.toISOString() });
      expect(server).toMatchObject({ status: 'STOPPED', lastStopClean: false });
      expect(recorded).toEqual([{ name: 'StopClean', value: 0, dimensions: undefined }]);
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

    it('stops the running instance of a failed server', async () => {
      await tasks.launchInstance({ serverId: 's1' });
      ec2.instances['i-new'] = { state: 'running', volumes: {} };
      const out = await tasks.stopAfterFailure({ serverId: 's1', since: LATER });
      expect(ec2.calls).toContain('stop i-new');
      expect(out).toEqual({ serverId: 's1', since: LATER, instanceId: 'i-new' });
    });

    it('waits for a pending instance, which EC2 cannot stop yet', async () => {
      await tasks.launchInstance({ serverId: 's1' });
      await expect(tasks.stopAfterFailure({ serverId: 's1' })).rejects.toBeInstanceOf(NotReady);
      expect(ec2.calls).not.toContain('stop i-new');
    });

    it('stops and records an instance the record never learned about', async () => {
      ec2.instances['i-lost'] = { state: 'running', volumes: {} };
      ec2.tags['i-lost'] = { serverId: 's1' };
      const out = await tasks.stopAfterFailure({ serverId: 's1' });
      expect(ec2.calls).toEqual(['stop i-lost']);
      await tasks.markFailed({ ...out, error: { Error: 'Error' } });
      expect(server).toMatchObject({ status: 'FAILED', instanceId: 'i-lost' });
    });

    it('stops a recorded instance EC2 does not list yet', async () => {
      setup({ status: 'STARTING', instanceId: 'i-1' });
      await tasks.stopAfterFailure({ serverId: 's1' });
      expect(ec2.calls).toEqual(['stop i-1']);
    });

    it('has nothing to stop when no instance was launched', async () => {
      const out = await tasks.stopAfterFailure({ serverId: 's1' });
      expect(ec2.calls).toEqual([]);
      expect(out.instanceId).toBeUndefined();
    });

    it('says so when the instance could not be stopped', async () => {
      setup({ status: 'STARTING', instanceId: 'i-1' });
      await tasks.markFailed({ serverId: 's1', error: { Error: 'States.Timeout' }, cleanupError: { Error: 'x' } });
      expect(server.statusMessage).toContain('its instance could not be stopped');
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
