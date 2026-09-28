import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Step Functions workflows and task Lambdas, the event bus, state sync, archive sweep and usage reconciler. */
export class OrchestrationStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Orchestration', props);
  }
}
