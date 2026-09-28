import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { CfnRole } from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { envConfig } from '../lib/config.js';
import { addChecks } from '../lib/hearth-app.js';
import { GameInfraStack } from '../lib/stacks/game-infra.js';

const app = new App();
const stack = new GameInfraStack(app, { config: envConfig('dev'), region: 'us-west-2' });
addChecks(app);
app.synth();
const template = Template.fromStack(stack);

function launchTemplateData(): Record<string, unknown> {
  const templates = template.findResources('AWS::EC2::LaunchTemplate');
  const [resource] = Object.values(templates) as { Properties: { LaunchTemplateData: Record<string, unknown> } }[];
  if (!resource) throw new Error('no launch template');
  return resource.Properties.LaunchTemplateData;
}

describe('GameInfraStack', () => {
  it('is named per environment and region', () => {
    expect(stack.stackName).toBe('hearth-dev-GameInfra-us-west-2');
  });

  describe('VPC', () => {
    it('has one public subnet per configured AZ and no NAT gateway', () => {
      template.resourceCountIs('AWS::EC2::NatGateway', 0);
      template.resourceCountIs('AWS::EC2::Subnet', 3);
      for (const az of ['us-west-2a', 'us-west-2b', 'us-west-2c']) {
        template.hasResourceProperties('AWS::EC2::Subnet', { AvailabilityZone: az, MapPublicIpOnLaunch: true });
      }
    });

    it('logs rejected traffic', () => {
      template.hasResourceProperties('AWS::EC2::FlowLog', {
        TrafficType: 'REJECT',
        LogDestinationType: 'cloud-watch-logs',
      });
      template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    });

    it('has an S3 gateway endpoint', () => {
      template.hasResourceProperties('AWS::EC2::VPCEndpoint', { VpcEndpointType: 'Gateway' });
    });
  });

  describe('Minecraft security group', () => {
    it('only allows TCP 25565 in', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'hearth-dev-minecraft-java',
        SecurityGroupIngress: [
          Match.objectLike({ IpProtocol: 'tcp', FromPort: 25565, ToPort: 25565, CidrIp: '0.0.0.0/0' }),
        ],
      });
    });
  });

  describe('instance role', () => {
    it('is assumed by EC2 and can use SSM', () => {
      const role = template.toJSON().Resources[stack.getLogicalId(stack.instanceRole.node.defaultChild as CfnRole)];
      expect(role.Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({ Service: 'ec2.amazonaws.com' });
      expect(JSON.stringify(role.Properties.ManagedPolicyArns)).toContain('policy/AmazonSSMManagedInstanceCore');
    });

    it('can only publish metrics to its environment namespace', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'cloudwatch:PutMetricData',
              Effect: 'Allow',
              Resource: '*',
              Condition: { StringEquals: { 'cloudwatch:namespace': 'Hearth/dev' } },
            },
          ],
        },
      });
    });

    it('has no S3 access', () => {
      const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
      expect(policies).not.toMatch(/"s3:/);
    });
  });

  describe('Minecraft launch template', () => {
    const data = launchTemplateData();

    it('launches ARM t4g.medium with unlimited credits', () => {
      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateName: 'hearth-dev-minecraft-java',
        LaunchTemplateData: Match.objectLike({
          InstanceType: 't4g.medium',
          CreditSpecification: { CpuCredits: 'unlimited' },
          ImageId: { Ref: Match.stringLikeRegexp('al2023.*arm64') },
        }),
      });
    });

    it('requires IMDSv2 with a hop limit containers cannot reach', () => {
      expect(data.MetadataOptions).toEqual({ HttpTokens: 'required', HttpPutResponseHopLimit: 1 });
    });

    it('stops rather than terminates on shutdown', () => {
      expect(data.InstanceInitiatedShutdownBehavior).toBe('stop');
    });

    it('keeps the encrypted data volume when the instance is terminated', () => {
      expect(data.BlockDeviceMappings).toEqual([
        { DeviceName: '/dev/xvda', Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 16, VolumeType: 'gp3' } },
        { DeviceName: '/dev/sdf', Ebs: { DeleteOnTermination: false, Encrypted: true, VolumeSize: 10, VolumeType: 'gp3' } },
      ]);
    });

    it('tags instances and volumes with app, env and game', () => {
      const expected = Match.arrayWith([
        { Key: 'app', Value: 'hearth' },
        { Key: 'env', Value: 'dev' },
        { Key: 'game', Value: 'minecraft-java' },
      ]);
      template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
        LaunchTemplateData: Match.objectLike({
          TagSpecifications: [
            { ResourceType: 'instance', Tags: expected },
            { ResourceType: 'volume', Tags: expected },
          ],
        }),
      });
    });

    it('runs the startup script that mounts the data volume', () => {
      const userData = (data.UserData as { 'Fn::Base64': string })['Fn::Base64'];
      expect(userData.startsWith('#!/bin/bash\n')).toBe(true);
      expect(userData).toContain('DATA_DEVICE=/dev/sdf');
      expect(userData).toContain('DATA_MOUNT=/srv/hearth');
    });
  });
});
