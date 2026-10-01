import { GetParameterCommand, ParameterNotFound, SSMClient } from '@aws-sdk/client-ssm';
import {
  agentChannelParameter,
  agentReleaseKey,
  type AgentChannel,
  type AgentRelease,
  type AgentTarget,
} from '@hearth/shared';

export interface AgentReleases {
  /** The release a channel points at, or undefined if the channel has none yet. */
  target(channel: AgentChannel): Promise<AgentTarget | undefined>;
}

/**
 * Reads channel parameters (written by the release and promote workflows), caching each for a
 * minute: many agents start at once, and a promotion taking a minute to apply is fine.
 */
export function ssmAgentReleases(opts: {
  env: string;
  bucket: string;
  get?: (name: string) => Promise<string | undefined>;
  now?: () => number;
  ttlMs?: number;
}): AgentReleases {
  const { env, bucket, now = Date.now, ttlMs = 60_000 } = opts;
  const get = opts.get ?? ssmGetter();
  const cache = new Map<AgentChannel, { at: number; target: AgentTarget | undefined }>();

  return {
    async target(channel) {
      const hit = cache.get(channel);
      if (hit && now() - hit.at < ttlMs) return hit.target;
      const value = await get(agentChannelParameter(env, channel));
      const target = value ? toTarget(JSON.parse(value) as AgentRelease, bucket) : undefined;
      cache.set(channel, { at: now(), target });
      return target;
    },
  };
}

function toTarget({ version, sha256 }: AgentRelease, bucket: string): AgentTarget {
  if (!version || !sha256) throw new Error('Agent channel parameter is missing version or sha256');
  return { version, sha256, url: `s3://${bucket}/${agentReleaseKey(version)}` };
}

function ssmGetter(client = new SSMClient({})) {
  return async (name: string) => {
    try {
      const out = await client.send(new GetParameterCommand({ Name: name }));
      return out.Parameter?.Value;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
  };
}
