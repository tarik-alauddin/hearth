import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { dynamoInvitesStore, newInvite } from './invites.js';

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

const now = new Date('2026-10-08T12:00:00Z');

describe('newInvite', () => {
  it('lasts 7 days, with a matching TTL in epoch seconds', () => {
    const invite = newInvite('s1', 'u1', now);
    expect(invite).toMatchObject({
      serverId: 's1',
      createdBy: 'u1',
      createdAt: '2026-10-08T12:00:00.000Z',
      expiresAt: '2026-10-15T12:00:00.000Z',
      expiresAtEpoch: Date.parse('2026-10-15T12:00:00Z') / 1000,
    });
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
  });
});

describe('dynamoInvitesStore', () => {
  it('creates an invite without overwriting another', async () => {
    const { client, sent } = fakeClient();
    const invite = newInvite('s1', 'u1', now);
    await dynamoInvitesStore(client, 'hearth-dev-Invites').create(invite);
    expect((sent[0] as PutCommand).input).toEqual({
      TableName: 'hearth-dev-Invites',
      Item: invite,
      ConditionExpression: 'attribute_not_exists(code)',
    });
  });

  it('treats an expired invite as gone, as TTL deletes it only later', async () => {
    const invite = newInvite('s1', 'u1', now);
    const { client } = fakeClient(() => ({ Item: invite }));
    const store = dynamoInvitesStore(client, 't');

    expect(await store.getActive(invite.code, now)).toEqual(invite);
    expect(await store.getActive(invite.code, new Date('2026-10-15T12:00:00Z'))).toBeUndefined();
    const { client: missing } = fakeClient(() => ({}));
    expect(await dynamoInvitesStore(missing, 't').getActive('NOPE', now)).toBeUndefined();
  });

  it("lists a server's unexpired invites, newest first, every page", async () => {
    const pages = [{ Items: [{ code: 'A' }], LastEvaluatedKey: { code: 'A' } }, { Items: [{ code: 'B' }] }];
    const { client, sent } = fakeClient(() => pages.shift());
    const invites = await dynamoInvitesStore(client, 't').listActiveForServer('s1', now);

    expect(invites.map((i) => i.code)).toEqual(['A', 'B']);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      IndexName: 'byServer',
      KeyConditionExpression: 'serverId = :serverId',
      FilterExpression: 'expiresAt > :now',
      ExpressionAttributeValues: { ':serverId': 's1', ':now': '2026-10-08T12:00:00.000Z' },
      ScanIndexForward: false,
    });
  });

  it('revokes only an invite of the given server', async () => {
    const { client, sent } = fakeClient();
    expect(await dynamoInvitesStore(client, 't').revoke('A', 's1')).toBe(true);
    expect((sent[0] as DeleteCommand).input).toMatchObject({
      Key: { code: 'A' },
      ConditionExpression: 'serverId = :serverId',
      ExpressionAttributeValues: { ':serverId': 's1' },
    });

    const { client: other } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    expect(await dynamoInvitesStore(other, 't').revoke('A', 's2')).toBe(false);
  });
});
