import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { dynamoServersStore } from './servers.js';

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

describe('dynamoServersStore', () => {
  it('finds a server through the byInstance index', async () => {
    const { client, sent } = fakeClient(() => ({ Items: [{ serverId: 's1', instanceId: 'i-1' }] }));
    const server = await dynamoServersStore(client, 'hearth-dev-Servers').findByInstance('i-1');

    expect(server?.serverId).toBe('s1');
    const query = sent[0] as QueryCommand;
    expect(query).toBeInstanceOf(QueryCommand);
    expect(query.input).toMatchObject({
      TableName: 'hearth-dev-Servers',
      IndexName: 'byInstance',
      ExpressionAttributeValues: { ':instanceId': 'i-1' },
    });
  });

  it('refuses to guess when two servers claim one instance', async () => {
    const { client } = fakeClient(() => ({ Items: [{ serverId: 's1' }, { serverId: 's2' }] }));
    await expect(dynamoServersStore(client, 't').findByInstance('i-1')).rejects.toThrow('More than one server');
  });

  it('records a report only while the server is on the calling instance', async () => {
    const { client, sent } = fakeClient();
    const at = new Date('2026-09-28T12:00:00Z');
    const ok = await dynamoServersStore(client, 't').recordAgentReport(
      's1',
      'i-1',
      { state: 'ready', agentVersion: '0.1.0' },
      at,
    );

    expect(ok).toBe(true);
    const update = sent[0] as UpdateCommand;
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input).toMatchObject({
      Key: { serverId: 's1' },
      ConditionExpression: 'instanceId = :instanceId',
      UpdateExpression: 'SET agentState = :state, agentVersion = :version, agentReportedAt = :at REMOVE agentMessage',
      ExpressionAttributeValues: {
        ':state': 'ready',
        ':version': '0.1.0',
        ':at': '2026-09-28T12:00:00.000Z',
        ':instanceId': 'i-1',
      },
    });
  });

  it('returns false when the condition fails', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    const ok = await dynamoServersStore(client, 't').recordAgentReport(
      's1',
      'i-2',
      { state: 'ready', agentVersion: '0.1.0' },
      new Date(),
    );
    expect(ok).toBe(false);
  });
});
