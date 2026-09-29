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
}

/** Response to create, start and stop. */
export interface ServerOperationResult {
  serverId: string;
  status: ServerStatus;
  /** Set when nothing was started because the server was already in the requested state. */
  unchanged?: boolean;
}

/** `GET /admin/servers?limit=&cursor=` (limit 1–100, default 50) */
export interface ListServersResponse {
  servers: ServerRecord[];
  /** Present when there are more servers; pass it back as `cursor` for the next page. */
  cursor?: string;
}
