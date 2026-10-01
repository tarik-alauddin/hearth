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

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}
