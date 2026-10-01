import { DefaultStackSynthesizer, Stack, Tags } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';
import { ALERT_EMAIL, AWS_ACCOUNT, HOME_REGION, MONTHLY_BUDGET_USD, envConfig } from '../config.js';

/**
 * Account-wide resources, deployed once (with dev's CDK bootstrap): a monthly budget for everything
 * tagged app=hearth. Needs `app` activated as a cost allocation tag in Billing (see the README).
 */
export class AccountStack extends Stack {
  constructor(scope: Construct) {
    super(scope, 'hearth-account', {
      stackName: 'hearth-account',
      env: { account: AWS_ACCOUNT, region: HOME_REGION },
      synthesizer: new DefaultStackSynthesizer({ qualifier: envConfig('dev').qualifier }),
    });
    Tags.of(this).add('app', 'hearth');

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
