import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AttributeType, ProjectionType, TableV2, type TablePropsV2 } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption, StorageClass } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import {
  ACCESS_BY_SERVER_INDEX,
  INVITES_BY_SERVER_INDEX,
  SERVERS_BY_INSTANCE_INDEX,
  SERVERS_BY_OWNER_INDEX,
  SERVERS_BY_STATUS_INDEX,
  backupBucket,
  uploadsBucket,
} from '@hearth/shared';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Stateful: DynamoDB tables and the S3 backup and uploads buckets. Retained with termination protection in prod. */
export class DataStack extends HearthStack {
  readonly serversTable: TableV2;
  readonly usersTable: TableV2;
  readonly serverAccessTable: TableV2;
  readonly invitesTable: TableV2;
  readonly backupBucket: Bucket;
  readonly uploadsBucket: Bucket;

  constructor(scope: Construct, props: HearthStackProps) {
    const { isProd, env } = props.config;
    super(scope, 'Data', { ...props, terminationProtection: isProd });
    const removalPolicy = isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.serversTable = new TableV2(this, 'Servers', {
      tableName: `hearth-${env}-Servers`,
      partitionKey: { name: 'serverId', type: AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: isProd,
      removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: SERVERS_BY_INSTANCE_INDEX,
          partitionKey: { name: 'instanceId', type: AttributeType.STRING },
        },
        // Failed and stuck servers for the fleet check: only what it needs is projected.
        {
          indexName: SERVERS_BY_STATUS_INDEX,
          partitionKey: { name: 'status', type: AttributeType.STRING },
          sortKey: { name: 'statusChangedAt', type: AttributeType.STRING },
          projectionType: ProjectionType.INCLUDE,
          nonKeyAttributes: ['instanceId', 'instanceState'],
        },
        // A user's servers, for the server cap (counts those not destroyed).
        {
          indexName: SERVERS_BY_OWNER_INDEX,
          partitionKey: { name: 'ownerId', type: AttributeType.STRING },
          sortKey: { name: 'createdAt', type: AttributeType.STRING },
          projectionType: ProjectionType.INCLUDE,
          nonKeyAttributes: ['status'],
        },
      ],
    });

    // Accounts and access (M8). Keyed by the Cognito user's sub; admins are a Cognito group, not
    // recorded here. Same protection as Servers: these say who owns what.
    const table = (id: string, props: Omit<TablePropsV2, 'tableName' | 'pointInTimeRecoverySpecification' | 'deletionProtection' | 'removalPolicy'>) =>
      new TableV2(this, id, {
        tableName: `hearth-${env}-${id}`,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        deletionProtection: isProd,
        removalPolicy,
        ...props,
      });

    // Profile (from the sign-in token), approval and server limit.
    this.usersTable = table('Users', {
      partitionKey: { name: 'userId', type: AttributeType.STRING },
    });

    // Who can reach which server: one item per user and server, role owner or member.
    this.serverAccessTable = table('ServerAccess', {
      partitionKey: { name: 'userId', type: AttributeType.STRING },
      sortKey: { name: 'serverId', type: AttributeType.STRING },
      globalSecondaryIndexes: [
        {
          indexName: ACCESS_BY_SERVER_INDEX,
          partitionKey: { name: 'serverId', type: AttributeType.STRING },
          sortKey: { name: 'userId', type: AttributeType.STRING },
        },
      ],
    });

    // Invite links. TTL removes expired ones (a day or two late; reads check expiresAt themselves).
    this.invitesTable = table('Invites', {
      partitionKey: { name: 'code', type: AttributeType.STRING },
      timeToLiveAttribute: 'expiresAtEpoch',
      globalSecondaryIndexes: [
        {
          indexName: INVITES_BY_SERVER_INDEX,
          partitionKey: { name: 'serverId', type: AttributeType.STRING },
          sortKey: { name: 'createdAt', type: AttributeType.STRING },
        },
      ],
    });

    // Any backups. Versioned so an overwritten or deleted backup can be recovered.
    this.backupBucket = new Bucket(this, 'Backups', {
      bucketName: backupBucket(env, this.account, this.region),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          // Glacier IR bills a 90-day minimum: backups pruned by the newest-10 rule before day 90
          // are still billed to day 90. Accepted at this scale.
          id: 'glacier-ir-after-30-days',
          transitions: [
            { storageClass: StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: Duration.days(30) },
          ],
        },
        { id: 'expire-noncurrent-after-30-days', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(7) },
      ],
    });
    Validations.of(this.backupBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Server access logs would need a second bucket; only the API and agents touch backups.',
    });

    // User uploads, kept apart from backups: untrusted until repacked, and short-lived. Nothing
    // here needs recovering, so no versioning; files expire instead of being deleted.
    this.uploadsBucket = new Bucket(this, 'Uploads', {
      bucketName: uploadsBucket(env, this.account, this.region),
      // New landing files reach the repack Lambda (in ApiStack) through EventBridge.
      eventBridgeEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        // Repack reads a landing file once, within minutes; it has no delete permission.
        { id: 'expire-landing-after-1-day', prefix: 'landing/', expiration: Duration.days(1) },
        { id: 'expire-accepted-after-7-days', prefix: 'accepted/', expiration: Duration.days(7) },
        { id: 'expire-rejected-after-7-days', prefix: 'rejected/', expiration: Duration.days(7) },
        { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });
    Validations.of(this.uploadsBucket).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Server access logs would need a second bucket; uploads live a week at most.',
    });
    // CDK's helper that switches on the bucket's EventBridge notifications, at deploy time only.
    const notifications = this.node.tryFindChild('BucketNotificationsHandler050a0587b7544547bf325f094a3db834');
    if (notifications) {
      Validations.of(notifications).acknowledge({
        id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        reason: "CDK's bucket-notifications helper; the AWS-maintained policy only allows writing its logs.",
      });
    }
  }
}
