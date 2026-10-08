import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_SERVER_LIMIT, type UserProfile, type UserRecord } from '@hearth/shared';

/** Every read and write of the Users table. */
export interface UsersStore {
  getUser(userId: string): Promise<UserRecord | undefined>;
  /**
   * A signed-in user was seen: the first time creates their record (not approved, the default
   * server limit); every time refreshes the profile fields given and `lastSeenAt`. Approval and
   * limit are never touched here. Returns the record as it now stands.
   */
  recordSignIn(userId: string, profile: UserProfile, at: Date): Promise<UserRecord>;
  /** Admins: approves (or un-approves) a user. False if there's no such user. */
  setApproved(userId: string, approved: boolean, at: Date): Promise<boolean>;
}

const PROFILE_FIELDS = ['provider', 'email', 'name', 'username', 'displayName', 'picture'] as const;

export function createUsersStore(tableName: string): UsersStore {
  return dynamoUsersStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName);
}

export function dynamoUsersStore(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): UsersStore {
  return {
    async getUser(userId) {
      const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { userId }, ConsistentRead: true }));
      return Item as UserRecord | undefined;
    },

    async recordSignIn(userId, profile, at) {
      const fields = PROFILE_FIELDS.filter((field) => profile[field] !== undefined);
      const out = await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { userId },
          UpdateExpression: [
            'SET lastSeenAt = :at',
            'createdAt = if_not_exists(createdAt, :at)',
            'approved = if_not_exists(approved, :approved)',
            'serverLimit = if_not_exists(serverLimit, :limit)',
            ...fields.map((field) => `#${field} = :${field}`),
          ].join(', '),
          ExpressionAttributeNames: fields.length
            ? Object.fromEntries(fields.map((field) => [`#${field}`, field]))
            : undefined,
          ExpressionAttributeValues: {
            ':at': at.toISOString(),
            ':approved': false,
            ':limit': DEFAULT_SERVER_LIMIT,
            ...Object.fromEntries(fields.map((field) => [`:${field}`, profile[field]])),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return out.Attributes as UserRecord;
    },

    async setApproved(userId, approved, at) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { userId },
            UpdateExpression: approved ? 'SET approved = :approved, approvedAt = :at' : 'SET approved = :approved REMOVE approvedAt',
            ConditionExpression: 'attribute_exists(userId)',
            ExpressionAttributeValues: { ':approved': approved, ...(approved ? { ':at': at.toISOString() } : {}) },
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
