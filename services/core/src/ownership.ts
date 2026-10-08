import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { ServerAccessRecord, ServerRecord } from '@hearth/shared';

/** Writes that span the Servers and ServerAccess tables, so neither is ever left without the other. */
export interface OwnedServers {
  /**
   * Records a new server and its owner's access in one transaction: a server is never without its
   * owner's row, nor a row without its server. Fails (writing neither) if either already exists.
   */
  createOwnedServer(server: ServerRecord, owner: ServerAccessRecord): Promise<void>;
}

export function createOwnedServers(serversTable: string, accessTable: string): OwnedServers {
  return dynamoOwnedServers(DynamoDBDocumentClient.from(new DynamoDBClient({})), serversTable, accessTable);
}

export function dynamoOwnedServers(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  serversTable: string,
  accessTable: string,
): OwnedServers {
  return {
    async createOwnedServer(server, owner) {
      if (owner.serverId !== server.serverId || owner.role !== 'owner' || owner.userId !== server.ownerId) {
        throw new Error("The access row must be the server's owner's");
      }
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: serversTable, Item: server, ConditionExpression: 'attribute_not_exists(serverId)' } },
            { Put: { TableName: accessTable, Item: owner, ConditionExpression: 'attribute_not_exists(userId)' } },
          ],
        }),
      );
    },
  };
}
