// The game agent's states. The agent (Go) mirrors these, and the request and response shapes of
// its routes (AgentConfig, AgentStatusReport, …), which are defined in ./api/schemas.ts.

export const AGENT_STATES = ['starting', 'ready', 'stopping', 'stopped', 'error'] as const;

export type AgentState = (typeof AGENT_STATES)[number];

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}
