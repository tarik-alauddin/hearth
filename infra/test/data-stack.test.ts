import { Match, Template } from 'aws-cdk-lib/assertions';
import { testApp } from './test-app.js';
import { describe, expect, it } from 'vitest';
import type { EnvName } from '@hearth/shared';
import { envConfig } from '../lib/config.js';
import { addChecks } from '../lib/hearth-app.js';
import { DataStack } from '../lib/stacks/data.js';

function synth(env: EnvName) {
  const app = testApp();
  const stack = new DataStack(app, { config: envConfig(env) });
  addChecks(app);
  app.synth();
  return { stack, template: Template.fromStack(stack) };
}

describe('DataStack', () => {
  const dev = synth('dev');
  const prod = synth('prod');

  describe('Servers table', () => {
    it('is keyed by serverId, on demand, with point-in-time recovery', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: 'hearth-dev-Servers',
        KeySchema: [{ AttributeName: 'serverId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
        Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
      });
    });

    it('has a byInstance index on instanceId', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: 'byInstance',
            KeySchema: [{ AttributeName: 'instanceId', KeyType: 'HASH' }],
          }),
        ]),
      });
    });

    it('has a byStatus index on status + statusChangedAt with a small projection', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        GlobalSecondaryIndexes: Match.arrayWith([
          {
            IndexName: 'byStatus',
            KeySchema: [
              { AttributeName: 'status', KeyType: 'HASH' },
              { AttributeName: 'statusChangedAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['instanceId', 'instanceState'] },
          },
        ]),
      });
    });

    it('is retained with deletion protection in prod', () => {
      prod.template.hasResource('AWS::DynamoDB::GlobalTable', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
        Properties: Match.objectLike({
          Replicas: [Match.objectLike({ DeletionProtectionEnabled: true })],
        }),
      });
    });

    it('can be torn down in dev', () => {
      dev.template.hasResource('AWS::DynamoDB::GlobalTable', {
        DeletionPolicy: 'Delete',
        Properties: Match.objectLike({
          Replicas: [Match.objectLike({ DeletionProtectionEnabled: false })],
        }),
      });
    });
  });

  describe('accounts and access tables', () => {
    const tables = (template: Template) => template.findResources('AWS::DynamoDB::GlobalTable') as Record<
      string,
      { DeletionPolicy: string; Properties: { TableName: string; Replicas: { DeletionProtectionEnabled: boolean; PointInTimeRecoverySpecification: unknown }[] } }
    >;

    it('Servers has a byOwner index on ownerId + createdAt, projecting status for the cap count', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: 'hearth-dev-Servers',
        GlobalSecondaryIndexes: Match.arrayWith([
          {
            IndexName: 'byOwner',
            KeySchema: [
              { AttributeName: 'ownerId', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['status'] },
          },
        ]),
      });
    });

    it('Users is keyed by the Cognito sub', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: 'hearth-dev-Users',
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('ServerAccess is keyed by user + server, with a byServer index for a server’s people', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: 'hearth-dev-ServerAccess',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'serverId', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'byServer',
            KeySchema: [
              { AttributeName: 'serverId', KeyType: 'HASH' },
              { AttributeName: 'userId', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          }),
        ],
      });
    });

    it('Invites is keyed by code, expires through TTL, with a byServer index newest first', () => {
      dev.template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
        TableName: 'hearth-dev-Invites',
        KeySchema: [{ AttributeName: 'code', KeyType: 'HASH' }],
        TimeToLiveSpecification: { AttributeName: 'expiresAtEpoch', Enabled: true },
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'byServer',
            KeySchema: [
              { AttributeName: 'serverId', KeyType: 'HASH' },
              { AttributeName: 'createdAt', KeyType: 'RANGE' },
            ],
          }),
        ],
      });
    });

    it('every table has point-in-time recovery, and is retained and protected in prod only', () => {
      for (const table of Object.values(tables(prod.template))) {
        expect(table.DeletionPolicy).toBe('Retain');
        expect(table.Properties.Replicas[0]?.DeletionProtectionEnabled).toBe(true);
        expect(table.Properties.Replicas[0]?.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      }
      for (const table of Object.values(tables(dev.template))) {
        expect(table.DeletionPolicy).toBe('Delete');
        expect(table.Properties.Replicas[0]?.DeletionProtectionEnabled).toBe(false);
      }
      expect(Object.values(tables(dev.template)).map((t) => t.Properties.TableName).sort()).toEqual([
        'hearth-dev-Invites',
        'hearth-dev-ServerAccess',
        'hearth-dev-Servers',
        'hearth-dev-Users',
      ]);
    });
  });

  describe('backup bucket', () => {
    it('blocks public access, encrypts, and is versioned', () => {
      dev.template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'hearth-dev-backups-138300868928-us-west-2',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
        },
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('denies requests without TLS', () => {
      dev.template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Action: 's3:*',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('moves backups to Glacier Instant Retrieval and expires old versions', () => {
      dev.template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ Transitions: [{ StorageClass: 'GLACIER_IR', TransitionInDays: 30 }] }),
            Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } }),
          ]),
        },
      });
    });

    it('is retained and never auto-emptied in prod', () => {
      prod.template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
      prod.template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    });

    it('is emptied and deleted with the stack in dev', () => {
      dev.template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
      dev.template.resourceCountIs('Custom::S3AutoDeleteObjects', 2); // backups and uploads
    });
  });

  describe('uploads bucket', () => {
    const uploads = () => {
      const [, bucket] = Object.entries(dev.template.findResources('AWS::S3::Bucket')).find(([id]) => id.startsWith('Uploads'))!;
      return (bucket as { Properties: Record<string, unknown> }).Properties;
    };

    it('is its own bucket: private, encrypted, not versioned', () => {
      const props = uploads();
      expect(props.BucketName).toBe('hearth-dev-uploads-138300868928-us-west-2');
      expect(props.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(JSON.stringify(props.BucketEncryption)).toContain('AES256');
      expect(props.VersioningConfiguration).toBeUndefined();
    });

    it('sends its events to EventBridge, where repack picks up new landing files', () => {
      dev.template.hasResourceProperties('Custom::S3BucketNotifications', {
        NotificationConfiguration: { EventBridgeConfiguration: {} },
      });
    });

    it('expires landing files after a day and repack results after a week', () => {
      const rules = (uploads().LifecycleConfiguration as { Rules: Record<string, unknown>[] }).Rules;
      expect(rules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ Prefix: 'landing/', ExpirationInDays: 1, Status: 'Enabled' }),
          expect.objectContaining({ Prefix: 'accepted/', ExpirationInDays: 7, Status: 'Enabled' }),
          expect.objectContaining({ Prefix: 'rejected/', ExpirationInDays: 7, Status: 'Enabled' }),
          expect.objectContaining({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
        ]),
      );
    });

    it('denies requests without TLS', () => {
      const policies = Object.values(dev.template.findResources('AWS::S3::BucketPolicy')) as {
        Properties: { Bucket: { Ref: string }; PolicyDocument: { Statement: { Effect: string; Condition?: unknown }[] } };
      }[];
      const policy = policies.find((p) => p.Properties.Bucket.Ref.startsWith('Uploads'));
      expect(policy?.Properties.PolicyDocument.Statement).toContainEqual(
        expect.objectContaining({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      );
    });
  });

  it('has termination protection in prod only', () => {
    expect(prod.stack.terminationProtection).toBe(true);
    expect(dev.stack.terminationProtection).toBe(false);
  });
});
