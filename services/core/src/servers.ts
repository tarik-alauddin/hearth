import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  SERVERS_BY_INSTANCE_INDEX,
  type AgentStatusReport,
  type InstanceState,
  type ServerRecord,
  type ServerStatus,
} from '@hearth/shared';

/**
 * Every read and write of the Servers table. Status changes are conditional transitions, so the
 * rules about which state may follow which live here and nowhere else.
 */
export interface ServersStore {
  findByInstance(instanceId: string): Promise<ServerRecord | undefined>;
  /** Agent routes. Returns false if the server is no longer on this instance. */
  recordAgentReport(serverId: string, instanceId: string, report: AgentStatusReport, at: Date): Promise<boolean>;
  /**
   * State sync: records what EC2 says about the server's instance. Returns false if the server is
   * no longer on this instance, or a newer state is already recorded (events arrive out of order).
   */
  recordInstanceState(
    serverId: string,
    instanceId: string,
    state: InstanceState,
    at: Date,
    publicIp?: string,
  ): Promise<boolean>;
  /** Moves `status` to `to` only if it's currently one of `from`. Returns false if it wasn't. */
  transition(serverId: string, change: Transition): Promise<boolean>;
}

export interface Transition {
  from: readonly ServerStatus[];
  to: ServerStatus;
  /** Also require the server to still be on this instance. */
  instanceId?: string;
}

export function createServersStore(tableName: string): ServersStore {
  return dynamoServersStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName);
}

export function dynamoServersStore(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): ServersStore {
  /** Runs a conditional update; false when the condition didn't hold. */
  async function conditionalUpdate(input: Omit<UpdateCommandInput, 'TableName'>): Promise<boolean> {
    try {
      await client.send(new UpdateCommand({ TableName: tableName, ...input }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

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
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${set.join(', ')}${report.message === undefined ? ' REMOVE agentMessage' : ''}`,
        // The index is eventually consistent; only write if the server is still on this instance.
        ConditionExpression: 'instanceId = :instanceId',
        ExpressionAttributeValues: values,
      });
    },

    async recordInstanceState(serverId, instanceId, state, at, publicIp) {
      const set = ['instanceState = :state', 'instanceStateAt = :at'];
      const remove: string[] = [];
      const values: Record<string, unknown> = { ':state': state, ':at': at.toISOString(), ':instanceId': instanceId };
      if (state === 'running') set.push('lastStartedAt = :at');
      if (state === 'stopped') set.push('lastStoppedAt = :at');
      // A public IP only means something while the instance runs; each start gets a new one.
      if (state === 'running' && publicIp) {
        set.push('publicIp = :publicIp');
        values[':publicIp'] = publicIp;
      } else {
        remove.push('publicIp');
      }
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
        ConditionExpression:
          'instanceId = :instanceId AND (attribute_not_exists(instanceStateAt) OR instanceStateAt < :at)',
        ExpressionAttributeValues: values,
      });
    },

    async transition(serverId, { from, to, instanceId }) {
      if (from.length === 0) throw new Error('transition needs at least one from status');
      const values: Record<string, unknown> = { ':to': to };
      const allowed = from.map((status, i) => {
        values[`:from${i}`] = status;
        return `:from${i}`;
      });
      let condition = `#status IN (${allowed.join(', ')})`;
      if (instanceId !== undefined) {
        condition += ' AND instanceId = :instanceId';
        values[':instanceId'] = instanceId;
      }
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: 'SET #status = :to',
        ConditionExpression: condition,
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: values,
      });
    },
  };
}
