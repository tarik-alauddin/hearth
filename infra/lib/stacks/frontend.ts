import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** React app on S3 + CloudFront. */
export class FrontendStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Frontend', props);
  }
}
