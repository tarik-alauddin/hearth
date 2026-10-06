import { emfMetrics, type Metrics, type ServersStore } from '@hearth/core';
import { METRICS, type ServerRecord, type ServerStatus } from '@hearth/shared';

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
/** The agent couldn't be stopped through Run Command; the stop workflow stops the instance anyway. */
export class AgentStopFailed extends Error {
  override name = 'AgentStopFailed';
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
  /** Failure path: the instance stopAfterFailure found for this server, if any. */
  instanceId?: string;
  /** Stop: the Run Command stopping the agent. */
  commandId?: string;
  /** Stop: set when stopping the agent failed or timed out, and the instance is stopped anyway. */
  agentStopError?: unknown;
}

/** Which workflow a task runs in (create | start | stop), passed by the state machine. */
export interface TaskContext {
  workflow?: string;
}

export interface InstanceInfo {
  state: string;
  /** Device name → volume ID. */
  volumes: Record<string, string>;
}

export interface Ec2 {
  /** Launches one instance, tagged in the same call so it is never without its tags. */
  runInstance(
    region: string,
    req: { subnetId: string; launchTemplateId: string; clientToken: string; tags: Record<string, string> },
  ): Promise<string>;
  /** Undefined while EC2 doesn't know the instance (yet): a new instance takes a moment to show up. */
  describeInstance(region: string, instanceId: string): Promise<InstanceInfo | undefined>;
  /** Every instance tagged with this server's ID, whatever its state. */
  findInstances(region: string, serverId: string): Promise<{ instanceId: string; state: string }[]>;
  createTags(region: string, resourceIds: string[], tags: Record<string, string>): Promise<void>;
  startInstance(region: string, instanceId: string): Promise<void>;
  stopInstance(region: string, instanceId: string): Promise<void>;
}

export type CommandStatus = 'pending' | 'success' | 'failed';

/** Run Command, for Hearth's own SSM documents. */
export interface Ssm {
  /** Sends the document to one instance; returns the command ID. */
  sendCommand(region: string, req: { instanceId: string; documentName: string }): Promise<string>;
  /** How the command went on the instance; 'pending' until it finishes. */
  commandStatus(region: string, req: { commandId: string; instanceId: string }): Promise<CommandStatus>;
  /** Cancels the command if it hasn't finished. */
  cancelCommand(region: string, req: { commandId: string; instanceId: string }): Promise<void>;
}

/** Per game region: where to launch, from which launch template, and the stop-agent document (GameInfraStack). */
export type GameInfra = Record<
  string,
  { subnetIds: string[]; launchTemplates: Record<string, { id: string }>; stopAgentDocument: string }
>;

export interface TaskDeps {
  env: string;
  store: Pick<ServersStore, 'getServer' | 'transition'>;
  ec2: Ec2;
  ssm: Ssm;
  gameInfra: GameInfra;
  now?: () => Date;
  metrics?: Metrics;
}

/** The device name of the data volume; see GameInfraStack. */
export const DATA_DEVICE = '/dev/sdf';

export function workflowTasks({ env, store, ec2, ssm, gameInfra, now = () => new Date(), metrics = emfMetrics(env) }: TaskDeps) {
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
    /** Create: launch from the launch template, trying each AZ; PROVISIONING → STARTING. */
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
          // Tagged at launch: the failure path finds a server's instances by this tag.
          instanceId = await ec2.runInstance(record.region, {
            subnetId,
            launchTemplateId: template.id,
            clientToken: `${serverId}-${i}`,
            tags: { serverId, Name: `hearth-${env}-${serverId}` },
          });
          break;
        } catch (err) {
          if (!(err instanceof CapacityError)) throw err;
        }
      }
      if (!instanceId) throw new CapacityError(`No capacity for ${record.game} in any AZ of ${record.region}`);

      await transition(serverId, {
        from: ['PROVISIONING'],
        to: 'STARTING',
        set: { instanceId },
        remove: ['statusMessage'],
      });
      return { serverId, since };
    },

    /** Create: once the instance runs, record and tag its data volume. */
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

    /** Create and start: STARTING → RUNNING, recording how long it took to become ready. */
    async markRunning(state: WorkflowState, context: TaskContext = {}): Promise<WorkflowState> {
      const record = await server(state.serverId);
      await transition(state.serverId, {
        from: ['STARTING'],
        to: 'RUNNING',
        instanceId: requireInstance(record),
        remove: ['statusMessage'],
      });
      if (state.since) {
        const seconds = Math.round((now().getTime() - Date.parse(state.since)) / 1000);
        metrics.record(METRICS.timeToReady, seconds, 'Seconds', { Workflow: context.workflow ?? 'unknown' });
      }
      return state;
    },

    /**
     * Stop, first: stop the agent through Run Command while the instance is fully up. The agent saves
     * the game and stops it, as it would during an OS shutdown, and reports `stopped`.
     */
    async stopAgent({ serverId }: WorkflowState): Promise<WorkflowState> {
      const record = await server(serverId, 'STOPPING');
      const instanceId = requireInstance(record);
      const since = now().toISOString();
      // An instance that isn't running (e.g. a FAILED server's) has no agent to stop.
      const instance = await ec2.describeInstance(record.region, instanceId);
      if (instance?.state !== 'running') return { serverId, since };
      const documentName = gameInfra[record.region]?.stopAgentDocument;
      if (!documentName) throw new Error(`No stop-agent document for ${record.region}`);
      const commandId = await ssm.sendCommand(record.region, { instanceId, documentName });
      return { serverId, since, commandId };
    },

    /** Stop: wait until the agent has stopped (the command returns once the agent has exited). */
    async waitForAgentStop(state: WorkflowState): Promise<WorkflowState> {
      if (!state.commandId) return state;
      const record = await server(state.serverId);
      const instanceId = requireInstance(record);
      const status = await ssm.commandStatus(record.region, { commandId: state.commandId, instanceId });
      if (status === 'pending') throw new NotReady(`Waiting for the agent on ${instanceId} to stop`);
      if (status === 'failed') throw new AgentStopFailed(`Stopping the agent on ${instanceId} failed`);
      return state;
    },

    /** Stop: power off the instance the API claimed as STOPPING. */
    async stopInstance(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId, 'STOPPING');
      // Gave up on the agent: cancel its stop command, so a later boot can never receive it.
      if (state.agentStopError && state.commandId) {
        const req = { commandId: state.commandId, instanceId: requireInstance(record) };
        await ssm.cancelCommand(record.region, req).catch((err: unknown) => {
          console.log(JSON.stringify({ msg: "couldn't cancel the agent stop command", ...req, err: String(err) }));
        });
      }
      // Keep the stop's start time from stopAgent, so the agent's stopped report counts as this stop's.
      const since = state.since ?? now().toISOString();
      await ec2.stopInstance(record.region, requireInstance(record));
      return { serverId: state.serverId, since };
    },

    /** Stop: wait until EC2 reports the instance stopped. */
    async waitForStopped(state: WorkflowState): Promise<WorkflowState> {
      const record = await server(state.serverId);
      const instance = await ec2.describeInstance(record.region, requireInstance(record));
      if (instance?.state !== 'stopped') throw new NotReady(`Instance ${record.instanceId} is ${instance?.state}`);
      return state;
    },

    /** Stop: STOPPING → STOPPED, noting whether the agent reported a clean stop (game saved). */
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
      metrics.record(METRICS.stopClean, clean ? 1 : 0, 'Count');
      return state;
    },

    /**
     * Create and start, before marking FAILED: a failed server never keeps an instance running.
     * Stops the record's instance and any other tagged with this server (a launch can fail before
     * the record learns its instance). Throws while one is still pending; the state machine retries.
     */
    async stopAfterFailure(input: WorkflowState): Promise<WorkflowState> {
      const record = await server(input.serverId);
      const found = await ec2.findInstances(record.region, input.serverId);
      const live = found.filter((i) => i.state === 'pending' || i.state === 'running');
      const toStop = new Set(live.map((i) => i.instanceId));
      // EC2 may not list a just-launched instance yet; stopping it by ID fails until it does.
      if (record.instanceId && !found.some((i) => i.instanceId === record.instanceId)) toStop.add(record.instanceId);
      if (live.some((i) => i.state === 'pending')) throw new NotReady(`An instance of ${input.serverId} is still pending`);
      for (const instanceId of toStop) await ec2.stopInstance(record.region, instanceId);
      return { ...input, instanceId: record.instanceId ?? found.find((i) => i.state !== 'terminated')?.instanceId };
    },

    /**
     * Any workflow's failure path: mark the server FAILED with the reason. An instance the record
     * didn't know about is recorded, so the server can be started or stopped again.
     */
    async markFailed(
      input: WorkflowState & { error?: { Error?: string; Cause?: string }; cleanupError?: unknown },
    ): Promise<WorkflowState> {
      const stopFailed = input.cleanupError ? ' (its instance could not be stopped)' : '';
      const message = failureMessage(input.error) + stopFailed;
      const record = await store.getServer(input.serverId);
      const adopt = input.instanceId && !record?.instanceId ? { instanceId: input.instanceId } : {};
      const moved = await store.transition(input.serverId, {
        from: ['PROVISIONING', 'STARTING', 'STOPPING'],
        to: 'FAILED',
        set: { statusMessage: message, ...adopt },
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
