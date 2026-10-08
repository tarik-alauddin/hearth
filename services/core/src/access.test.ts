import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import type { ServerAccessRecord } from '@hearth/shared';
import { dynamoAccessStore } from './access.js';

/** A document client whose send() records commands and returns canned responses. */
function fakeClient(respond: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      return respond(command);
    },
  };
  return { client: client as never, sent };
}

const conditionFailed = () => {
  throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
};

const member: ServerAccessRecord = {
  userId: 'u2',
  serverId: 's1',
  role: 'member',
  addedAt: '2026-10-08T12:00:00.000Z',
  addedBy: 'u1',
  inviteCode: 'K7QXM2PD9VTRH4NBW3ZA',
};

describe('dynamoAccessStore', () => {
  it('grants access only to a user without any, so an owner never becomes a member', async () => {
    const { client, sent } = fakeClient();
    expect(await dynamoAccessStore(client, 'hearth-dev-ServerAccess').grant(member)).toBe(true);
    const put = sent[0] as PutCommand;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input).toEqual({
      TableName: 'hearth-dev-ServerAccess',
      Item: member,
      ConditionExpression: 'attribute_not_exists(userId)',
    });

    const { client: taken } = fakeClient(conditionFailed);
    expect(await dynamoAccessStore(taken, 't').grant(member)).toBe(false);
  });

  it('removes members only, never an owner', async () => {
    const { client, sent } = fakeClient();
    expect(await dynamoAccessStore(client, 't').removeMember('u2', 's1')).toBe(true);
    const del = sent[0] as DeleteCommand;
    expect(del).toBeInstanceOf(DeleteCommand);
    expect(del.input).toMatchObject({
      Key: { userId: 'u2', serverId: 's1' },
      ConditionExpression: '#role = :member',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':member': 'member' },
    });

    const { client: owner } = fakeClient(conditionFailed);
    expect(await dynamoAccessStore(owner, 't').removeMember('u1', 's1')).toBe(false);
  });

  it("lists a user's servers, every page", async () => {
    const pages = [
      { Items: [{ serverId: 's1' }], LastEvaluatedKey: { userId: 'u1', serverId: 's1' } },
      { Items: [{ serverId: 's2' }] },
    ];
    const { client, sent } = fakeClient(() => pages.shift());
    const access = await dynamoAccessStore(client, 't').listForUser('u1');

    expect(access.map((a) => a.serverId)).toEqual(['s1', 's2']);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': 'u1' },
    });
    expect((sent[1] as QueryCommand).input.ExclusiveStartKey).toEqual({ userId: 'u1', serverId: 's1' });
  });

  it("lists a server's owner and members through the byServer index", async () => {
    const { client, sent } = fakeClient(() => ({ Items: [{ userId: 'u1', role: 'owner' }, { userId: 'u2', role: 'member' }] }));
    const access = await dynamoAccessStore(client, 't').listForServer('s1');

    expect(access).toHaveLength(2);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      IndexName: 'byServer',
      KeyConditionExpression: 'serverId = :serverId',
      ExpressionAttributeValues: { ':serverId': 's1' },
    });
  });
});
