// Lambda entry point for the fleet check. Scheduled in prod; run on demand anywhere with
// `hearth fleet-check`, which prints the report this returns.
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { createServersStore, emfMetrics } from '@hearth/core';
import { fleetCheck, type FleetEc2 } from './fleet-check.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const env = requireEnv('HEARTH_ENV');

const ec2: FleetEc2 = {
  async hearthInstances(region) {
    const client = new EC2Client({ region });
    const found: Awaited<ReturnType<FleetEc2['hearthInstances']>> = [];
    let NextToken: string | undefined;
    do {
      const out = await client.send(
        new DescribeInstancesCommand({
          Filters: [
            { Name: 'tag:app', Values: ['hearth'] },
            { Name: 'tag:env', Values: [env] },
            { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] },
          ],
          NextToken,
        }),
      );
      for (const i of (out.Reservations ?? []).flatMap((r) => r.Instances ?? [])) {
        if (!i.InstanceId) continue;
        found.push({
          instanceId: i.InstanceId,
          state: i.State?.Name ?? 'unknown',
          launchedAt: i.LaunchTime?.toISOString(),
          serverId: i.Tags?.find((t) => t.Key === 'serverId')?.Value,
        });
      }
      NextToken = out.NextToken;
    } while (NextToken);
    return found;
  },
};

export const handler = fleetCheck({
  store: createServersStore(requireEnv('SERVERS_TABLE')),
  ec2,
  regions: requireEnv('GAME_REGIONS').split(','),
  metrics: emfMetrics(env),
});
