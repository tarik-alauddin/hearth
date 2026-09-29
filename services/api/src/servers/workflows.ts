import { ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { WorkflowName, Workflows } from './operations.js';

/** Starts the lifecycle state machines. Execution names come from the claim, so a repeat is a no-op. */
export function stepFunctionsWorkflows(arns: Record<WorkflowName, string>, client = new SFNClient({})): Workflows {
  return {
    async start(workflow, serverId, operationId) {
      try {
        await client.send(
          new StartExecutionCommand({
            stateMachineArn: arns[workflow],
            name: `${workflow}-${serverId}-${operationId}`,
            input: JSON.stringify({ serverId }),
          }),
        );
      } catch (err) {
        // Same name and input = this operation already started; nothing to do.
        if (!(err instanceof ExecutionAlreadyExists)) throw err;
      }
    },
  };
}
