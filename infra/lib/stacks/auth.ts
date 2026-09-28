import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Cognito user pool. */
export class AuthStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Auth', props);
  }
}
