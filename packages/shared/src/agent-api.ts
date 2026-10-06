import type { AgentTarget } from './agent-releases.js';
import type { GameId } from './games.js';

// Contract between the game agent and the API's agent routes. The agent (Go) mirrors these shapes.

/** `GET /agent/config` response. */
export interface AgentConfig {
  serverId: string;
  game: GameId;
  /** Game version to run, e.g. `1.21.4`. */
  version: string;
  image: string;
  port: number;
  /** The agent release this server's channel points at; absent until the channel has one. */
  agent?: AgentTarget;
  /** A requested restore: replace the game data with this backup before starting the game. */
  restore?: RestoreTarget;
  /** Ask for a stop after this many minutes with nobody playing; 0 = never. */
  idleStopMinutes: number;
}

export interface RestoreTarget {
  key: string;
  /** Presigned download link for `key`, valid for 15 minutes. */
  url: string;
}

/** `POST /agent/idle` request body: nobody has played for this long; stop the server. */
export interface IdleReport {
  idleMinutes: number;
}

/** `POST /agent/restored` request body: the game data now holds this backup. */
export interface RestoreDoneReport {
  key: string;
}

export const AGENT_STATES = ['starting', 'ready', 'stopping', 'stopped', 'error'] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/** `POST /agent/status` request body. */
export interface AgentStatusReport {
  state: AgentState;
  agentVersion: string;
  /** Short human-readable detail, e.g. the error when `state` is `error`. */
  message?: string;
}

/**
 * `POST /agent/backup-credentials` response: where to upload one backup, and short-lived
 * credentials that can write only that key.
 */
export interface BackupTarget {
  bucket: string;
  key: string;
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: string; // ISO 8601 UTC
  };
}

/** `POST /agent/backups` request body: a backup the agent finished uploading. */
export interface BackupDoneReport {
  key: string;
}

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}
