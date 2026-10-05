import type { AgentChannel } from './agent-releases.js';
import type { GameId } from './games.js';
import type { ServerRecord, ServerStatus } from './server.js';

// Contract between the admin API routes and the hearth CLI.

/** `POST /admin/servers` */
export interface CreateServerRequest {
  game: GameId;
  /** Game version, e.g. `1.21.4`. */
  version: string;
  /** Defaults to the home region. */
  region?: string;
  /** Defaults to stable. */
  agentChannel?: AgentChannel;
}

/** `POST /admin/servers/{id}/settings`: the settings to change. */
export interface UpdateSettingsRequest {
  agentChannel?: AgentChannel;
}

/** Response to create, start and stop. */
export interface ServerOperationResult {
  serverId: string;
  status: ServerStatus;
  /** Set when nothing was started because the server was already in the requested state. */
  unchanged?: boolean;
}

/** `POST /admin/servers/{id}/version`: a newer game release to run from the next start. */
export interface SetVersionRequest {
  version: string;
}

/** `POST /admin/servers/{id}/restore`: the backup to restore on the next start. */
export interface RestoreRequest {
  /** A key from the backups list, or just its file name; defaults to the newest backup. */
  key?: string;
  /** Restore even though the last stop wasn't clean (the current world may be in no backup). */
  force?: boolean;
}

/** One of a server's backups. */
export interface BackupSummary {
  key: string;
  takenAt: string; // ISO 8601 UTC, when the upload finished
  bytes: number;
}

/** `GET /admin/servers/{id}/backups`: newest first. */
export interface ListBackupsResponse {
  backups: BackupSummary[];
}

/** `GET /admin/servers?limit=&cursor=` (limit 1–100, default 50) */
export interface ListServersResponse {
  servers: ServerRecord[];
  /** Present when there are more servers; pass it back as `cursor` for the next page. */
  cursor?: string;
}
