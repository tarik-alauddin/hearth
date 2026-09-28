import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Discord interactions endpoint, email and Discord notifiers, usage recorder. */
export class IntegrationsStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Integrations', props);
  }
}
