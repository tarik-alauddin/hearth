import { readFileSync } from 'node:fs';
import { RemovalPolicy, Tags, Validations } from 'aws-cdk-lib';
import {
  AmazonLinuxCpuType,
  BlockDeviceVolume,
  CpuCredits,
  EbsDeviceVolumeType,
  FlowLogDestination,
  FlowLogTrafficType,
  GatewayVpcEndpointAwsService,
  InstanceInitiatedShutdownBehavior,
  InstanceType,
  IpAddresses,
  LaunchTemplate,
  MachineImage,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  UserData,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { GAME_DEFINITIONS, type GameDefinition, type GameId } from '@hearth/shared';
import { availabilityZones } from '../config.js';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

const USER_DATA = readFileSync(new URL('../user-data/game-instance.sh', import.meta.url), 'utf8');

/** Device name the startup script looks for; see user-data/game-instance.sh. */
export const DATA_DEVICE_NAME = '/dev/sdf';
const ROOT_VOLUME_GIB = 16;

export interface GameInfraStackProps extends HearthStackProps {
  readonly region: string;
}

/** One per game region: VPC, instance role, and a security group and launch template per game. */
export class GameInfraStack extends HearthStack {
  readonly vpc: Vpc;
  readonly instanceRole: Role;
  readonly securityGroups: Record<GameId, SecurityGroup>;
  readonly launchTemplates: Record<GameId, LaunchTemplate>;

  constructor(scope: Construct, props: GameInfraStackProps) {
    super(scope, 'GameInfra', props);
    const { env, isProd } = props.config;

    const flowLogs = new LogGroup(this, 'FlowLogs', {
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Public subnets only: instances need public IPs for players, so a NAT gateway would only add cost.
    this.vpc = new Vpc(this, 'Vpc', {
      vpcName: `hearth-${env}`,
      ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
      availabilityZones: availabilityZones(props.region),
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 20 }],
      flowLogs: {
        rejected: {
          trafficType: FlowLogTrafficType.REJECT,
          destination: FlowLogDestination.toCloudWatchLogs(flowLogs),
        },
      },
      gatewayEndpoints: { s3: { service: GatewayVpcEndpointAwsService.S3 } },
    });

    // No S3 access: the API will hand each agent credentials scoped to its own server's backups.
    this.instanceRole = new Role(this, 'InstanceRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: `Hearth ${env} game instances`,
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    this.instanceRole.addToPolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': `Hearth/${env}` } },
      }),
    );
    Validations.of(this.instanceRole).acknowledge({
      id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]',
      reason: 'AWS-maintained policy for Session Manager and Run Command.',
    });
    Validations.of(this.instanceRole).acknowledge({
      id: 'AwsSolutions-IAM5[Resource::*]',
      reason: 'PutMetricData has no resource ARNs; it is limited by the cloudwatch:namespace condition.',
    });

    const securityGroups: Partial<Record<GameId, SecurityGroup>> = {};
    const launchTemplates: Partial<Record<GameId, LaunchTemplate>> = {};
    for (const game of Object.values(GAME_DEFINITIONS)) {
      const securityGroup = this.securityGroup(env, game);
      securityGroups[game.id] = securityGroup;
      launchTemplates[game.id] = this.launchTemplate(env, game, securityGroup);
    }
    this.securityGroups = securityGroups as Record<GameId, SecurityGroup>;
    this.launchTemplates = launchTemplates as Record<GameId, LaunchTemplate>;
  }

  private securityGroup(env: string, game: GameDefinition): SecurityGroup {
    const sg = new SecurityGroup(this, `${game.id}-SecurityGroup`, {
      vpc: this.vpc,
      securityGroupName: `hearth-${env}-${game.id}`,
      description: `${game.displayName} game port`,
      allowAllOutbound: true,
    });
    const port = game.protocol === 'tcp' ? Port.tcp(game.port) : Port.udp(game.port);
    sg.addIngressRule(Peer.anyIpv4(), port, `${game.displayName} players`);
    Validations.of(sg).acknowledge({
      id: 'AwsSolutions-EC23',
      reason: 'Public game server: players connect from anywhere, on the game port only.',
    });
    return sg;
  }

  private launchTemplate(env: string, game: GameDefinition, securityGroup: SecurityGroup): LaunchTemplate {
    const template = new LaunchTemplate(this, `${game.id}-LaunchTemplate`, {
      launchTemplateName: `hearth-${env}-${game.id}`,
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      instanceType: new InstanceType(game.defaultInstanceType),
      cpuCredits: CpuCredits.UNLIMITED,
      role: this.instanceRole,
      securityGroup,
      userData: UserData.custom(USER_DATA),
      requireImdsv2: true,
      // Hop limit 1 keeps containers from reaching instance metadata and the role's credentials.
      httpPutResponseHopLimit: 1,
      instanceInitiatedShutdownBehavior: InstanceInitiatedShutdownBehavior.STOP,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: BlockDeviceVolume.ebs(ROOT_VOLUME_GIB, {
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
        {
          // The world lives here. Kept on termination; archiving deletes it only after a verified backup.
          deviceName: DATA_DEVICE_NAME,
          volume: BlockDeviceVolume.ebs(game.dataVolumeGiB, {
            volumeType: EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: false,
          }),
        },
      ],
    });
    Tags.of(template).add('game', game.id);
    Tags.of(template).add('Name', `hearth-${env}-${game.id}`);
    return template;
  }
}
