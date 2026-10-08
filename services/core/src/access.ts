import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ACCESS_BY_SERVER_INDEX, type ServerAccessRecord } from '@hearth/shared';

/** Every read and write of the ServerAccess table: which users can reach which servers, and as what. */
export interface AccessStore {
  getAccess(userId: string, serverId: string): Promise<ServerAccessRecord | undefined>;
  /**
   * Gives a user access to a server. False if they already have some (an owner never becomes a
   * member, and accepting a second invite changes nothing).
   */
  grant(access: ServerAccessRecord): Promise<boolean>;
  /** Removes a member. False if they weren't one: an owner's access is never removed this way. */
  removeMember(userId: string, serverId: string): Promise<boolean>;
  /** Every server a user can reach, with their role. */
  listForUser(userId: string): Promise<ServerAccessRecord[]>;
  /** Everyone who can reach a server: its owner and members. */
  listForServer(serverId: string): Promise<ServerAccessRecord[]>;
}

export function createAccessStore(tableName: string): AccessStore {
  return dynamoAccessStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName);
}

export function dynamoAccessStore(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): AccessStore {
  /** Runs a conditional write; false when the condition didn't hold. */
  async function conditional(write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  /** Every page of a query. */
  async function queryAll(input: Omit<QueryCommand['input'], 'TableName' | 'ExclusiveStartKey'>) {
    const items: ServerAccessRecord[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await client.send(new QueryCommand({ TableName: tableName, ...input, ExclusiveStartKey: start }));
      items.push(...((out.Items ?? []) as ServerAccessRecord[]));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }

  return {
    async getAccess(userId, serverId) {
      const { Item } = await client.send(
        new GetCommand({ TableName: tableName, Key: { userId, serverId }, ConsistentRead: true }),
      );
      return Item as ServerAccessRecord | undefined;
    },

    async grant(access) {
      return conditional(() =>
        client.send(
          new PutCommand({ TableName: tableName, Item: access, ConditionExpression: 'attribute_not_exists(userId)' }),
        ),
      );
    },

    async removeMember(userId, serverId) {
      return conditional(() =>
        client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { userId, serverId },
            ConditionExpression: '#role = :member',
            ExpressionAttributeNames: { '#role': 'role' },
            ExpressionAttributeValues: { ':member': 'member' },
          }),
        ),
      );
    },

    async listForUser(userId) {
      return queryAll({ KeyConditionExpression: 'userId = :userId', ExpressionAttributeValues: { ':userId': userId } });
    },

    async listForServer(serverId) {
      return queryAll({
        IndexName: ACCESS_BY_SERVER_INDEX,
        KeyConditionExpression: 'serverId = :serverId',
        ExpressionAttributeValues: { ':serverId': serverId },
      });
    },
  };
}
