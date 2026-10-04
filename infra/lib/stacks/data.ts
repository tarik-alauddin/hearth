import { Duration, RemovalPolicy, Validations } from 'aws-cdk-lib';
import { AttributeType, ProjectionType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { BlockPublicAccess, Bucket, BucketEncryption, StorageClass } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { SERVERS_BY_INSTANCE_INDEX, SERVERS_BY_STATUS_INDEX, backupBucket } from '@hearth/shared';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Stateful: DynamoDB tables and the S3 backup bucket. Retained with termination protection in prod. */
export class DataStack extends HearthStack {
  readonly serversTable: TableV2;
  readonly backupBucket: Bucket;

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
  }
}
