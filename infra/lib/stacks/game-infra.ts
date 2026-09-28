import type { Construct } from 'constructs';
import { HearthStack, type HearthStackProps } from '../hearth-stack.js';

export interface GameInfraStackProps extends HearthStackProps {
  readonly region: string;
}

/** One per game region: VPC, launch templates, security groups, instance role, agent bundle. */
export class GameInfraStack extends HearthStack {
  constructor(scope: Construct, props: GameInfraStackProps) {
    super(scope, 'GameInfra', props);
  }
}
