import { DefaultStackSynthesizer, RemovalPolicy, Stack, Tags, Validations } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { agentReleasesBucket } from '@hearth/shared';
import type { Construct } from 'constructs';
import { ALERT_EMAIL, AWS_ACCOUNT, HOME_REGION, MONTHLY_BUDGET_USD, envConfig } from '../config.js';

/**
 * Account-wide resources, deployed once (with dev's CDK bootstrap): the agent releases bucket shared
 * by every environment, and a monthly budget for everything tagged app=hearth (which needs `app`
 * activated as a cost allocation tag in Billing; see the README).
 */
export class AccountStack extends Stack {
  constructor(scope: Construct) {
    super(scope, 'hearth-account', {
      stackName: 'hearth-account',
      env: { account: AWS_ACCOUNT, region: HOME_REGION },
      synthesizer: new DefaultStackSynthesizer({ qualifier: envConfig('dev').qualifier }),
    });
    Tags.of(this).add('app', 'hearth');

    // Agent releases: immutable, versioned binaries (agent/<version>/…) that channels point at.
    // Kept forever: they're small, and any of them may be a rollback target.
    const releases = new Bucket(this, 'AgentReleases', {
      bucketName: agentReleasesBucket(AWS_ACCOUNT),
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(releases).acknowledge({
      id: 'AwsSolutions-S1',
      reason: 'Only the release workflow writes and only game instances read; access logs would need a second bucket.',
    });

    const email = [{ subscriptionType: 'EMAIL', address: ALERT_EMAIL }];
    const at = (threshold: number, notificationType: 'ACTUAL' | 'FORECASTED') => ({
      notification: { notificationType, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
      subscribers: email,
    });
    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'hearth-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: 'USD' },
        costFilters: { TagKeyValue: ['user:app$hearth'] },
      },
      notificationsWithSubscribers: [at(80, 'ACTUAL'), at(100, 'ACTUAL'), at(100, 'FORECASTED')],
    });
  }
}
