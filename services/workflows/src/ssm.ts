import { GetCommandInvocationCommand, SSMClient, SendCommandCommand } from '@aws-sdk/client-ssm';
import type { CommandStatus, Ssm } from './tasks.js';

const FINISHED: Record<string, CommandStatus> = {
  Success: 'success',
  Failed: 'failed',
  TimedOut: 'failed',
  Cancelled: 'failed',
};

/** Run Command through the AWS SDK, one client per region. */
export function sdkSsm(): Ssm {
  const clients = new Map<string, SSMClient>();
  const client = (region: string) => {
    let c = clients.get(region);
    if (!c) {
      c = new SSMClient({ region });
      clients.set(region, c);
    }
    return c;
  };

  return {
    async sendCommand(region, { instanceId, documentName }) {
      const out = await client(region).send(
        new SendCommandCommand({
          DocumentName: documentName,
          DocumentVersion: '$LATEST',
          InstanceIds: [instanceId],
          // How long the command may wait to be delivered; the document bounds how long it runs.
          TimeoutSeconds: 60,
        }),
      );
      const id = out.Command?.CommandId;
      if (!id) throw new Error('SendCommand returned no command ID');
      return id;
    },

    async commandStatus(region, { commandId, instanceId }) {
      try {
        const out = await client(region).send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
        );
        return FINISHED[out.Status ?? ''] ?? 'pending';
      } catch (err) {
        // Right after SendCommand the invocation may not exist yet.
        if ((err as { name?: string }).name === 'InvocationDoesNotExist') return 'pending';
        throw err;
      }
    },
  };
}
