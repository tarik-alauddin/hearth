import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { ServerAccessRecord, ServerRecord } from '@hearth/shared';
import { dynamoOwnedServers } from './ownership.js';

function fakeClient() {
  const sent: unknown[] = [];
  return { client: { send: async (c: unknown) => (sent.push(c), {}) } as never, sent };
}

const server: ServerRecord = {
  serverId: 's1',
  ownerId: 'u1',
  game: 'minecraft-java',
  region: 'us-west-2',
  status: 'PROVISIONING',
  version: '26.3',
  autoUpdate: false,
};
const owner: ServerAccessRecord = { userId: 'u1', serverId: 's1', role: 'owner', addedAt: 'now', addedBy: 'u1' };

describe('createOwnedServer', () => {
  it('writes the server and its owner row in one transaction, neither overwriting anything', async () => {
    const { client, sent } = fakeClient();
    await dynamoOwnedServers(client, 'hearth-dev-Servers', 'hearth-dev-ServerAccess').createOwnedServer(server, owner);

    expect(sent).toHaveLength(1);
    const transaction = sent[0] as TransactWriteCommand;
    expect(transaction).toBeInstanceOf(TransactWriteCommand);
    expect(transaction.input.TransactItems).toEqual([
      { Put: { TableName: 'hearth-dev-Servers', Item: server, ConditionExpression: 'attribute_not_exists(serverId)' } },
      { Put: { TableName: 'hearth-dev-ServerAccess', Item: owner, ConditionExpression: 'attribute_not_exists(userId)' } },
    ]);
  });

  it("refuses a row that isn't the server's owner's, writing nothing", async () => {
    const { client, sent } = fakeClient();
    const store = dynamoOwnedServers(client, 's', 'a');
    await expect(store.createOwnedServer(server, { ...owner, role: 'member' })).rejects.toThrow();
    await expect(store.createOwnedServer(server, { ...owner, userId: 'u2' })).rejects.toThrow();
    await expect(store.createOwnedServer(server, { ...owner, serverId: 's2' })).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});
