import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SERVERS_BY_INSTANCE_INDEX, type AgentStatusReport, type ServerRecord } from '@hearth/shared';

export interface ServersStore {
  findByInstance(instanceId: string): Promise<ServerRecord | undefined>;
  /** Returns false if the server is no longer on this instance. */
  recordAgentReport(serverId: string, instanceId: string, report: AgentStatusReport, at: Date): Promise<boolean>;
}

export function dynamoServersStore(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): ServersStore {
  return {
    async findByInstance(instanceId) {
      const { Items = [] } = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: SERVERS_BY_INSTANCE_INDEX,
          KeyConditionExpression: 'instanceId = :instanceId',
          ExpressionAttributeValues: { ':instanceId': instanceId },
          Limit: 2,
        }),
      );
      if (Items.length > 1) throw new Error(`More than one server has instance ${instanceId}`);
      return Items[0] as ServerRecord | undefined;
    },

    async recordAgentReport(serverId, instanceId, report, at) {
      const set = ['agentState = :state', 'agentVersion = :version', 'agentReportedAt = :at'];
      const values: Record<string, unknown> = {
        ':state': report.state,
        ':version': report.agentVersion,
        ':at': at.toISOString(),
        ':instanceId': instanceId,
      };
      if (report.message !== undefined) {
        set.push('agentMessage = :message');
        values[':message'] = report.message;
      }
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { serverId },
            UpdateExpression: `SET ${set.join(', ')}${report.message === undefined ? ' REMOVE agentMessage' : ''}`,
            // The index is eventually consistent; only write if the server is still on this instance.
            ConditionExpression: 'instanceId = :instanceId',
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
  };
}
