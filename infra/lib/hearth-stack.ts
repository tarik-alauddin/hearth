import { DefaultStackSynthesizer, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { stackName, type EnvConfig } from './config.js';

export interface HearthStackProps extends StackProps {
  readonly config: EnvConfig;
  /** Defaults to the home region. */
  readonly region?: string;
}

/** Base for every environment stack: naming, account/region, bootstrap qualifier and tags. */
export abstract class HearthStack extends Stack {
  readonly config: EnvConfig;

  protected constructor(scope: Construct, stack: string, props: HearthStackProps) {
    const region = props.region ?? props.config.homeRegion;
    const name = stackName(props.config.env, stack, props.region);
    super(scope, name, {
      ...props,
      stackName: name,
      env: { account: props.config.account, region },
      synthesizer: new DefaultStackSynthesizer({ qualifier: props.config.qualifier }),
    });
    this.config = props.config;
    Tags.of(this).add('app', 'hearth');
    Tags.of(this).add('env', props.config.env);
  }
}
