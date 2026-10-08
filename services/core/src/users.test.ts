import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { dynamoUsersStore } from './users.js';

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

const at = new Date('2026-10-08T12:00:00Z');

describe('dynamoUsersStore', () => {
  it('reads a user consistently', async () => {
    const { client, sent } = fakeClient(() => ({ Item: { userId: 'u1', approved: true } }));
    expect(await dynamoUsersStore(client, 'hearth-dev-Users').getUser('u1')).toMatchObject({ approved: true });
    expect((sent[0] as GetCommand).input).toEqual({ TableName: 'hearth-dev-Users', Key: { userId: 'u1' }, ConsistentRead: true });
  });

  describe('recordSignIn', () => {
    it('creates a new user unapproved with the default limit, and refreshes the profile given', async () => {
      const { client, sent } = fakeClient(() => ({ Attributes: { userId: 'u1', approved: false, serverLimit: 3 } }));
      const user = await dynamoUsersStore(client, 't').recordSignIn('u1', { provider: 'Discord', username: 'tarik', picture: 'https://p' }, at);

      expect(user).toMatchObject({ approved: false, serverLimit: 3 });
      const update = sent[0] as UpdateCommand;
      expect(update).toBeInstanceOf(UpdateCommand);
      expect(update.input).toMatchObject({
        Key: { userId: 'u1' },
        UpdateExpression:
          'SET lastSeenAt = :at, createdAt = if_not_exists(createdAt, :at), approved = if_not_exists(approved, :approved), ' +
          'serverLimit = if_not_exists(serverLimit, :limit), #provider = :provider, #username = :username, #picture = :picture',
        ExpressionAttributeNames: { '#provider': 'provider', '#username': 'username', '#picture': 'picture' },
        ExpressionAttributeValues: {
          ':at': '2026-10-08T12:00:00.000Z',
          ':approved': false,
          ':limit': 3,
          ':provider': 'Discord',
          ':username': 'tarik',
          ':picture': 'https://p',
        },
        ReturnValues: 'ALL_NEW',
      });
    });

    it('never sets approval or the limit outright, so a returning user keeps theirs', async () => {
      const { client, sent } = fakeClient(() => ({ Attributes: {} }));
      await dynamoUsersStore(client, 't').recordSignIn('u1', {}, at);
      const expression = (sent[0] as UpdateCommand).input.UpdateExpression ?? '';
      expect(expression).toContain('approved = if_not_exists(approved, :approved)');
      expect(expression).toContain('serverLimit = if_not_exists(serverLimit, :limit)');
      expect((sent[0] as UpdateCommand).input.ExpressionAttributeNames).toBeUndefined();
    });
  });

  describe('setApproved', () => {
    it('approves an existing user, recording when', async () => {
      const { client, sent } = fakeClient();
      expect(await dynamoUsersStore(client, 't').setApproved('u1', true, at)).toBe(true);
      expect((sent[0] as UpdateCommand).input).toMatchObject({
        UpdateExpression: 'SET approved = :approved, approvedAt = :at',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeValues: { ':approved': true, ':at': '2026-10-08T12:00:00.000Z' },
      });
    });

    it('un-approves, clearing when', async () => {
      const { client, sent } = fakeClient();
      await dynamoUsersStore(client, 't').setApproved('u1', false, at);
      expect((sent[0] as UpdateCommand).input.UpdateExpression).toBe('SET approved = :approved REMOVE approvedAt');
    });

    it('returns false for a user who has never signed in', async () => {
      const { client } = fakeClient(() => {
        throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
      });
      expect(await dynamoUsersStore(client, 't').setApproved('nobody', true, at)).toBe(false);
    });
  });
});
