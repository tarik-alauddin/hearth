import {
  CreateTagsCommand,
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import { CapacityError, type Ec2 } from './tasks.js';

const CAPACITY_ERRORS = new Set(['InsufficientInstanceCapacity', 'InsufficientCapacity']);

/** EC2 through the AWS SDK, one client per region; capacity errors become CapacityError. */
export function sdkEc2(): Ec2 {
  const clients = new Map<string, EC2Client>();
  const client = (region: string) => {
    let c = clients.get(region);
    if (!c) {
      c = new EC2Client({ region });
      clients.set(region, c);
    }
    return c;
  };
  const capacity = (err: unknown) => {
    const name = (err as { name?: string }).name ?? '';
    return CAPACITY_ERRORS.has(name) ? new CapacityError((err as Error).message) : err;
  };

  return {
    async runInstance(region, { subnetId, launchTemplateId, clientToken, tags }) {
      try {
        const out = await client(region).send(
          new RunInstancesCommand({
            // $Latest, not the default version: CloudFormation never moves a template's default.
            LaunchTemplate: { LaunchTemplateId: launchTemplateId, Version: '$Latest' },
            SubnetId: subnetId,
            MinCount: 1,
            MaxCount: 1,
            ClientToken: clientToken,
            // Added to the launch template's tags.
            TagSpecifications: [
              { ResourceType: 'instance', Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
            ],
          }),
        );
        const id = out.Instances?.[0]?.InstanceId;
        if (!id) throw new Error('RunInstances returned no instance');
        return id;
      } catch (err) {
        throw capacity(err);
      }
    },

    async describeInstance(region, instanceId) {
      const out = await client(region)
        .send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
        .catch((err: unknown) => {
          // EC2 is eventually consistent: a just-launched instance can be unknown for a few seconds.
          if ((err as { name?: string }).name === 'InvalidInstanceID.NotFound') return undefined;
          throw err;
        });
      const instance = out?.Reservations?.[0]?.Instances?.[0];
      if (!instance) return undefined;
      const volumes: Record<string, string> = {};
      for (const mapping of instance.BlockDeviceMappings ?? []) {
        if (mapping.DeviceName && mapping.Ebs?.VolumeId) volumes[mapping.DeviceName] = mapping.Ebs.VolumeId;
      }
      return { state: instance.State?.Name ?? 'unknown', volumes };
    },

    async findInstances(region, serverId) {
      const out = await client(region).send(
        new DescribeInstancesCommand({ Filters: [{ Name: 'tag:serverId', Values: [serverId] }] }),
      );
      return (out.Reservations ?? [])
        .flatMap((r) => r.Instances ?? [])
        .flatMap((i) => (i.InstanceId ? [{ instanceId: i.InstanceId, state: i.State?.Name ?? 'unknown' }] : []));
    },

    async createTags(region, resourceIds, tags) {
      await client(region).send(
        new CreateTagsCommand({
          Resources: resourceIds,
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    },

    async startInstance(region, instanceId) {
      try {
        await client(region).send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
      } catch (err) {
        throw capacity(err);
      }
    },

    async stopInstance(region, instanceId) {
      await client(region).send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
    },
  };
}
