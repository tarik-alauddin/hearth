import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

/** Stateful: DynamoDB tables and the S3 backup bucket. Retained with termination protection in prod. */
export class DataStack extends HearthStack {
  constructor(scope: Construct, props: HearthStackProps) {
    super(scope, 'Data', props);
  }
}
