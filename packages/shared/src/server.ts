import type { AgentState } from './agent-api.js';
import type { GameId } from './games.js';

export const SERVER_STATUSES = [
  'PROVISIONING',
  'STOPPED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'ARCHIVING',
  'ARCHIVED',
  'RESTORING',
  'FAILED',
] as const;

export type ServerStatus = (typeof SERVER_STATUSES)[number];

/** EC2 instance states, as reported by EC2 state-change events. */
export const INSTANCE_STATES = ['pending', 'running', 'stopping', 'stopped', 'shutting-down', 'terminated'] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];

/**
 * The instance states state sync receives (the EventBridge rule filters on these). The in-between
 * states add nothing that `status` doesn't already say.
 */
export const SYNCED_INSTANCE_STATES = ['running', 'stopped', 'terminated'] as const satisfies readonly InstanceState[];

export function isInstanceState(value: unknown): value is InstanceState {
  return typeof value === 'string' && (INSTANCE_STATES as readonly string[]).includes(value);
}

/** GSI on `Servers` keyed by `instanceId` */
export const SERVERS_BY_INSTANCE_INDEX = 'byInstance';

/** GSI on `Servers`: `status` + `statusChangedAt`, for finding failed or stuck servers. */
export const SERVERS_BY_STATUS_INDEX = 'byStatus';

/** An item in the `Servers` table. Fields are added as milestones need them. */
export interface ServerRecord {
  /** ULID; the table's partition key. */
  serverId: string;
  ownerId: string;
  game: GameId;
  region: string;
  status: ServerStatus;
  version: string; // game version
  autoUpdate: boolean;
  instanceId?: string;
  volumeId?: string;
  // Last report from the agent. `status` is owned by the lifecycle workflows; these are the agent's view.
  agentState?: AgentState;
  agentVersion?: string;
  agentReportedAt?: string; // ISO 8601 UTC
  agentMessage?: string;
  // What EC2 last said about the instance, recorded by state sync.
  instanceState?: InstanceState;
  instanceStateAt?: string; // ISO 8601 UTC, the event's time
  publicIp?: string; // only while running; changes on every start
  lastStartedAt?: string;
  lastStoppedAt?: string;
  createdAt?: string; // ISO 8601 UTC
  statusChangedAt?: string; // ISO 8601 UTC; set by every status change
  lastOperationId?: string; // the latest create/start/stop claim; names its workflow execution
  // Written by the lifecycle workflows.
  statusMessage?: string; // why the server is FAILED
  lastStopClean?: boolean; // the agent reported a clean stop (world saved) during the last stop
}
