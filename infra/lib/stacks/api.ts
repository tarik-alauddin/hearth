import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** User, agent and bot routes, the Discord OAuth callback and usage routes. */
export class ApiStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Api', props);
  }
}
