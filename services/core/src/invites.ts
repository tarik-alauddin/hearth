import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { INVITE_TTL_DAYS, INVITES_BY_SERVER_INDEX, type InviteRecord } from '@hearth/shared';
import { newInviteCode } from './ids.js';

/**
 * Every read and write of the Invites table. An expired invite counts as gone everywhere: DynamoDB's
 * TTL deletes it only some time after `expiresAt`, so reads check the time themselves.
 */
export interface InvitesStore {
  /** Writes a new invite; fails if the code is taken (with 100 random bits, it never is). */
  create(invite: InviteRecord): Promise<void>;
  /** The invite, unless it doesn't exist or has expired. */
  getActive(code: string, now: Date): Promise<InviteRecord | undefined>;
  /** A server's unexpired invites, newest first. */
  listActiveForServer(serverId: string, now: Date): Promise<InviteRecord[]>;
  /** Deletes an invite of this server. False if there's no such invite for it. */
  revoke(code: string, serverId: string): Promise<boolean>;
}

/** A new invite to `serverId`, valid for INVITE_TTL_DAYS. */
export function newInvite(serverId: string, createdBy: string, now: Date): InviteRecord {
  const expires = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  return {
    code: newInviteCode(),
    serverId,
    createdBy,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    expiresAtEpoch: Math.floor(expires.getTime() / 1000),
  };
}

export function createInvitesStore(tableName: string): InvitesStore {
  return dynamoInvitesStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName);
}

export function dynamoInvitesStore(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string): InvitesStore {
  return {
    async create(invite) {
      await client.send(
        new PutCommand({ TableName: tableName, Item: invite, ConditionExpression: 'attribute_not_exists(code)' }),
      );
    },

    async getActive(code, now) {
      const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { code }, ConsistentRead: true }));
      const invite = Item as InviteRecord | undefined;
      return invite && invite.expiresAt > now.toISOString() ? invite : undefined;
    },

    async listActiveForServer(serverId, now) {
      const invites: InviteRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: INVITES_BY_SERVER_INDEX,
            KeyConditionExpression: 'serverId = :serverId',
            FilterExpression: 'expiresAt > :now',
            ExpressionAttributeValues: { ':serverId': serverId, ':now': now.toISOString() },
            ScanIndexForward: false,
            ExclusiveStartKey: start,
          }),
        );
        invites.push(...((out.Items ?? []) as InviteRecord[]));
        start = out.LastEvaluatedKey;
      } while (start);
      return invites;
    },

    async revoke(code, serverId) {
      try {
        await client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { code },
            ConditionExpression: 'serverId = :serverId',
            ExpressionAttributeValues: { ':serverId': serverId },
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
