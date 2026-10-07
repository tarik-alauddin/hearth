// Lambda entry point for state sync; OrchestrationStack subscribes it to EC2 state-change events.
import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { createServersStore } from '@hearth/core';
import { stateSync, type InstanceInfo } from './state-sync.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// One client per region: game regions forward their EC2 events to the home region.
const ec2Clients = new Map<string, EC2Client>();

async function describeInstance(region: string, instanceId: string): Promise<InstanceInfo | undefined> {
  let ec2 = ec2Clients.get(region);
  if (!ec2) {
    ec2 = new EC2Client({ region });
    ec2Clients.set(region, ec2);
  }
  try {
    const out = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = out.Reservations?.[0]?.Instances?.[0];
    if (!instance) return undefined;
    return {
      tags:Object.fromEntries((instance.Tags ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? ''])),
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'InvalidInstanceID.NotFound') return undefined;
    throw err;
  }
}

export const handler = stateSync({
  env: requireEnv('HEARTH_ENV'),
  store: createServersStore(requireEnv('SERVERS_TABLE')),
  describeInstance,
});
