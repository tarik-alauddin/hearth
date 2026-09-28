export const GAMES = ['minecraft-java'] as const;

export type GameId = (typeof GAMES)[number];

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
}
