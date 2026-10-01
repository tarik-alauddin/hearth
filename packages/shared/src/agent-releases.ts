// Agent releases: versioned binaries in one bucket, and per-environment channels in SSM that say which
// release servers on that channel should run.

export const AGENT_CHANNELS = ['canary', 'stable'] as const;

export type AgentChannel = (typeof AGENT_CHANNELS)[number];

export const DEFAULT_AGENT_CHANNEL: AgentChannel = 'stable';

export function isAgentChannel(value: unknown): value is AgentChannel {
  return typeof value === 'string' && (AGENT_CHANNELS as readonly string[]).includes(value);
}

/** The bucket every environment's releases live in (one per account). */
export const agentReleasesBucket = (account: string) => `hearth-agent-releases-${account}`;

/** Where a release's binary lives in the bucket; its SHA-256 is beside it at `<key>.sha256`. */
export const agentReleaseKey = (version: string) => `agent/${version}/hearth-agent-linux-arm64`;

/** SSM parameter holding a channel's current release. */
export const agentChannelParameter = (env: string, channel: AgentChannel) => `/hearth/${env}/agent/${channel}`;

/** A channel parameter's value. */
export interface AgentRelease {
  version: string;
  sha256: string;
}

/** What `/agent/config` tells the agent to run. */
export interface AgentTarget extends AgentRelease {
  /** `s3://bucket/key` of the binary. */
  url: string;
}
