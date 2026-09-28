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

/** GSI on `Servers` keyed by `instanceId` */
export const SERVERS_BY_INSTANCE_INDEX = 'byInstance';

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
}
