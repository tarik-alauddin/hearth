import type { ServersStore } from '@hearth/core';
import type { ServerRecord, ServerStatus } from '@hearth/shared';

// Step Functions task handlers for the create, start and stop workflows. Each task is short;
// waiting is done by throwing NotReady, which the state machine retries on a fixed interval.

/** Retried by the state machine until it succeeds or the retries run out. */
export class NotReady extends Error {
  override name = 'NotReady';
}
/** EC2 has no capacity for this instance type right now; retried with backoff. */
export class CapacityError extends Error {
  override name = 'CapacityError';
}
/** The agent reported an error; not retried. */
export class AgentError extends Error {
  override name = 'AgentError';
}

/** What flows between workflow steps. */
export interface WorkflowState {
  serverId: string;
  /** When this start or stop began (ISO 8601); agent reports from before it are ignored. */
  since?: string;
}

export interface InstanceInfo {
  state: string;
  /** Device name → volume ID. */
  volumes: Record<string, string>;
}

export interface Ec2 {
  runInstance(region: string, req: { subnetId: string; launchTemplateId: string; version: string; clientToken: string }): Promise<string>;
  describeInstance(region: string, instanceId: string): Promise<InstanceInfo | undefined>;
  createTags(region: string, resourceIds: string[], tags: Record<string, string>): Promise<void>;
  startInstance(region: string, instanceId: string): Promise<void>;
  stopInstance(region: string, instanceId: string): Promise<void>;
}

/** Per game region: where to launch and from which launch template version (GameInfraStack). */
export type GameInfra = Record<
  string,
  { subnetIds: string[]; launchTemplates: Record<string, { id: string; version: string }> }
>;

export interface TaskDeps {
  env: string;
  store: Pick<ServersStore, 'getServer' | 'transition'>;
  ec2: Ec2;
  gameInfra: GameInfra;
  now?: () => Date;
}

/** The device name of the world volume; see GameInfraStack. */
export const DATA_DEVICE = '/dev/sdf';

export function workflowTasks({ env, store, ec2, gameInfra, now = () => new Date() }: TaskDeps) {
  async function server(serverId: string, expected?: ServerStatus): Promise<ServerRecord> {
    const record = await store.getServer(serverId);
    if (!record) throw new Error(`Server ${serverId} not found`);
    if (expected && record.status !== expected) {
      throw new Error(`Server ${serverId} is ${record.status}, expected ${expected}`);
    }
    return record;
  }

  function requireInstance(record: ServerRecord): string {
    if (!record.instanceId) throw new Error(`Server ${record.serverId} has no instance`);
    return record.instanceId;
  }

  async function transition(serverId: string, change: Parameters<TaskDeps['store']['transition']>[1]) {
    if (!(await store.transition(serverId, change))) {
      throw new Error(`Server ${serverId} couldn't move to ${change.to}: its state changed`);
    }
  }

  return {
    /** Create: launch from the pinned launch template, trying each AZ; PROVISIONING → STARTING. */
    async launchInstance({ serverId }: WorkflowState): Promise<WorkflowState> {
      const record = await server(serverId, 'PROVISIONING');
      const infra = gameInfra[record.region];
      const template = infra?.launchTemplates[record.game];
      if (!infra || !template) throw new Error(`No launch template for ${record.game} in ${record.region}`);

      const since = now().toISOString();
      let instanceId: string | undefined;
      for (const [i, subnetId] of infra.subnetIds.entries()) {
        try {
          // The client token makes a retried launch return the same instance instead of a second one.
          instanceId = await ec2.runInstance(record.region, {
            subnetId,
            launchTemplateId: template.id,
            version: template.version,
            clientToken: `${serverId}-${i}`,
          });
          break;
        } catch (err) {
          if (!(err instanceof CapacityError)) throw err;
        }
      }
      if (!instanceId) throw new CapacityError(`No capacity for ${record.game} in any AZ of ${record.region}`);

      await ec2.createTags(record.region, [instanceId], { serverId, Name: `hearth-${env}-${serverId}` });
      await transition(serverId, {
        from: ['PROVISIONING'],
        to: 'STARTING',
        set: { instanceId },
        remove: ['statusMessage'],
      });
      return { serverId, since };
    },

    /** Create: once the instance runs, record and tag its world volume. */
    async recordVolume(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId, 'STARTING');
      const instanceId = requireInstance(record);
      const instance = await ec2.describeInstance(record.region, instanceId);
      const volumeId = instance?.volumes[DATA_DEVICE];
      if (instance?.state !== 'running' || !volumeId) throw new NotReady(`Instance ${instanceId} isn't running yet`);
      await ec2.createTags(record.region, [volumeId], { serverId: state.serverId });
      // Same status: this only records the volume while the server is still starting on this instance.
      await transition(state.serverId, { from: ['STARTING'], to: 'STARTING', instanceId, set: { volumeId } });
      return state;
    },

    /** Start: power on the instance the API claimed as STARTING. */
    async startInstance({ serverId }: WorkflowState): Promise<WorkflowState> {
      const record = await server(serverId, 'STARTING');
      const since = now().toISOString();
      await ec2.startInstance(record.region, requireInstance(record));
      return { serverId, since };
    },

    /** Create and start: wait for the agent to report ready from this boot. */
    async waitForAgent(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId);
      const reported = (record.agentReportedAt ?? '') > (state.since ?? '');
      if (reported && record.agentState === 'ready') return state;
      if (reported && record.agentState === 'error') throw new AgentError(record.agentMessage ?? 'The agent reported an error');
      throw new NotReady(`Waiting for the agent on ${state.serverId}`);
    },

    /** Create and start: STARTING → RUNNING. */
    async markRunning(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId);
      await transition(state.serverId, {
        from: ['STARTING'],
        to: 'RUNNING',
        instanceId: requireInstance(record),
        remove: ['statusMessage'],
      });
      return state;
    },

    /** Stop: power off the instance the API claimed as STOPPING. The agent saves during shutdown. */
    async stopInstance({ serverId }: WorkflowState): Promise<WorkflowState> {
      const record = await server(serverId, 'STOPPING');
      const since = now().toISOString();
      await ec2.stopInstance(record.region, requireInstance(record));
      return { serverId, since };
    },

    /** Stop: wait until EC2 reports the instance stopped. */
    async waitForStopped(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId);
      const instance = await ec2.describeInstance(record.region, requireInstance(record));
      if (instance?.state !== 'stopped') throw new NotReady(`Instance ${record.instanceId} is ${instance?.state}`);
      return state;
    },

    /** Stop: STOPPING → STOPPED, noting whether the agent reported a clean stop (world saved). */
    async markStopped(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId);
      const clean = record.agentState === 'stopped' && (record.agentReportedAt ?? '') > (state.since ?? '');
      await transition(state.serverId, {
        from: ['STOPPING'],
        to: 'STOPPED',
        instanceId: requireInstance(record),
        set: { lastStopClean: clean },
        remove: ['statusMessage'],
      });
      return state;
    },

    /** Any workflow's failure path: mark the server FAILED with the reason. */
    async markFailed(input: WorkflowState & { error?: { Error?: string; Cause?: string } }): Promise<WorkflowState> {
      const message = failureMessage(input.error);
      const moved = await store.transition(input.serverId, {
        from: ['PROVISIONING', 'STARTING', 'STOPPING'],
        to: 'FAILED',
        set: { statusMessage: message },
      });
      console.log(JSON.stringify({ msg: 'workflow failed', serverId: input.serverId, message, markedFailed: moved }));
      return { serverId: input.serverId };
    },
  };
}

/** Step Functions passes Lambda errors as { Error: name, Cause: JSON with errorMessage }. */
export function failureMessage(error: { Error?: string; Cause?: string } | undefined): string {
  if (!error) return 'Unknown failure';
  try {
    const cause = JSON.parse(error.Cause ?? '') as { errorMessage?: string };
    if (cause.errorMessage) return `${error.Error}: ${cause.errorMessage}`.slice(0, 500);
  } catch {
    // Not JSON: e.g. a timeout, whose cause is plain text.
  }
  return `${error.Error ?? 'Error'}${error.Cause ? `: ${error.Cause}` : ''}`.slice(0, 500);
}
