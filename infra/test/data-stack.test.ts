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
        GlobalSecondaryIndexes: [
          Match.objectLike({
            IndexName: 'byInstance',
            KeySchema: [{ AttributeName: 'instanceId', KeyType: 'HASH' }],
          }),
        ],
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
      dev.template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    });
  });

  it('has termination protection in prod only', () => {
    expect(prod.stack.terminationProtection).toBe(true);
    expect(dev.stack.terminationProtection).toBe(false);
  });
});
