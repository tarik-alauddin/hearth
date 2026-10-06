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
  /** An accepted upload (from `POST /admin/uploads`) to start the server with, instead of new game data. */
  upload?: string;
}

/** `POST /admin/servers/{id}/settings`: the settings to change. */
export interface UpdateSettingsRequest {
  agentChannel?: AgentChannel;
  /** Stop after this many minutes with nobody playing (1–1440); 0 = never. */
  idleStopMinutes?: number;
}

/** Response to create, start and stop. */
export interface ServerOperationResult {
  serverId: string;
  status: ServerStatus;
  /** Set when nothing was started because the server was already in the requested state. */
  unchanged?: boolean;
}

/** `POST /admin/uploads`: start an upload of game data for this game. */
export interface CreateUploadRequest {
  game: GameId;
}

/**
 * `POST /admin/uploads` response: a presigned S3 form. Send a multipart/form-data POST to `url`
 * with every field in `fields`, then the file last as `file`. S3 refuses files over the size cap.
 */
export interface CreateUploadResponse {
  uploadId: string;
  url: string;
  fields: Record<string, string>;
  maxBytes: number;
  expiresAt: string; // ISO 8601 UTC
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
