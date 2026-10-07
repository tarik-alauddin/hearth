import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { InvalidCursor, dynamoServersStore } from './servers.js';

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

describe('clearRestore', () => {
  it('clears only the same restore, only while the server is on the calling instance', async () => {
    const { client, sent } = fakeClient();
    const key = 'servers/s1/20261004T120000Z.tar.gz';
    expect(await dynamoServersStore(client, 't').clearRestore('s1', 'i-1', key)).toBe(true);
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      Key: { serverId: 's1' },
      UpdateExpression: 'REMOVE restoreKey, restoreSource, restoreRequestedAt',
      ConditionExpression: 'instanceId = :instanceId AND restoreKey = :key',
      ExpressionAttributeValues: { ':instanceId': 'i-1', ':key': key },
    });
  });

  it('returns false when the condition fails', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    expect(await dynamoServersStore(client, 't').clearRestore('s1', 'i-1', 'k')).toBe(false);
  });
});

describe('recordBackup', () => {
  it('records the newest backup only while the server is on the calling instance', async () => {
    const { client, sent } = fakeClient();
    const ok = await dynamoServersStore(client, 't').recordBackup(
      's1',
      'i-1',
      { key: 'servers/s1/20261004T120000Z.tar.gz', bytes: 1234 },
      new Date('2026-10-04T12:01:00Z'),
    );

    expect(ok).toBe(true);
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      Key: { serverId: 's1' },
      UpdateExpression: 'SET lastBackupKey = :key, lastBackupBytes = :bytes, lastBackupAt = :at',
      ConditionExpression: 'instanceId = :instanceId',
      ExpressionAttributeValues: {
        ':key': 'servers/s1/20261004T120000Z.tar.gz',
        ':bytes': 1234,
        ':at': '2026-10-04T12:01:00.000Z',
        ':instanceId': 'i-1',
      },
    });
  });

  it('returns false when the server moved', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    const ok = await dynamoServersStore(client, 't').recordBackup('s1', 'i-2', { key: 'k', bytes: 1 }, new Date());
    expect(ok).toBe(false);
  });
});

describe('recordInstanceState', () => {
  const at = new Date('2026-09-29T12:00:00Z');

  it('records a running instance with its public IP and start time, ignoring older events', async () => {
    const { client, sent } = fakeClient();
    const ok = await dynamoServersStore(client, 't').recordInstanceState('s1', 'i-1', 'running', at, '35.1.2.3');

    expect(ok).toBe(true);
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      Key: { serverId: 's1' },
      UpdateExpression:
        'SET instanceState = :state, instanceStateAt = :at, lastStartedAt = :at, publicIp = :publicIp',
      ConditionExpression:
        'instanceId = :instanceId AND (attribute_not_exists(instanceStateAt) OR instanceStateAt < :at)',
      ExpressionAttributeValues: {
        ':state': 'running',
        ':at': '2026-09-29T12:00:00.000Z',
        ':instanceId': 'i-1',
        ':publicIp': '35.1.2.3',
      },
    });
  });

  it('records a stop time and clears the public IP when stopped', async () => {
    const { client, sent } = fakeClient();
    await dynamoServersStore(client, 't').recordInstanceState('s1', 'i-1', 'stopped', at);
    expect((sent[0] as UpdateCommand).input.UpdateExpression).toBe(
      'SET instanceState = :state, instanceStateAt = :at, lastStoppedAt = :at REMOVE publicIp',
    );
  });

  it('returns false for a stale event or a moved server', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    expect(await dynamoServersStore(client, 't').recordInstanceState('s1', 'i-1', 'stopped', at)).toBe(false);
  });
});

describe('transition', () => {
  it('changes status only from the allowed states', async () => {
    const { client, sent } = fakeClient();
    const ok = await dynamoServersStore(client, 't').transition('s1', {
      from: ['RUNNING', 'STOPPING'],
      to: 'STOPPED',
      instanceId: 'i-1',
    });

    expect(ok).toBe(true);
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      Key: { serverId: 's1' },
      UpdateExpression: 'SET #status = :to, statusChangedAt = :changedAt',
      ConditionExpression: '#status IN (:from0, :from1) AND instanceId = :instanceId',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':to': 'STOPPED', ':from0': 'RUNNING', ':from1': 'STOPPING', ':instanceId': 'i-1' },
    });
  });

  it('returns false when the server is in another state', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    expect(await dynamoServersStore(client, 't').transition('s1', { from: ['RUNNING'], to: 'STOPPED' })).toBe(false);
  });

  it('rejects an empty from list', async () => {
    const { client } = fakeClient();
    await expect(dynamoServersStore(client, 't').transition('s1', { from: [], to: 'STOPPED' })).rejects.toThrow();
  });
});

describe('transition with fields', () => {
  it('sets and removes fields in the same conditional write, without placeholder clashes', async () => {
    const { client, sent } = fakeClient();
    await dynamoServersStore(client, 't').transition('s1', {
      from: ['PROVISIONING'],
      to: 'STARTING',
      instanceId: 'i-old',
      set: { instanceId: 'i-new' },
      remove: ['statusMessage'],
    });
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      UpdateExpression: 'SET #status = :to, statusChangedAt = :changedAt, #set_instanceId = :set_instanceId REMOVE #rm_statusMessage',
      ConditionExpression: '#status IN (:from0) AND instanceId = :instanceId',
      ExpressionAttributeNames: { '#status': 'status', '#set_instanceId': 'instanceId', '#rm_statusMessage': 'statusMessage' },
      ExpressionAttributeValues: { ':to': 'STARTING', ':from0': 'PROVISIONING', ':instanceId': 'i-old', ':set_instanceId': 'i-new' },
    });
  });
});

describe('getServer', () => {
  it('reads one server consistently', async () => {
    const { client, sent } = fakeClient(() => ({ Item: { serverId: 's1' } }));
    expect((await dynamoServersStore(client, 't').getServer('s1'))?.serverId).toBe('s1');
    expect((sent[0] as { input: unknown }).input).toEqual({ TableName: 't', Key: { serverId: 's1' }, ConsistentRead: true });
  });
});

describe('createServer and listServers', () => {
  it('creates only if the ID is new', async () => {
    const { client, sent } = fakeClient();
    await dynamoServersStore(client, 't').createServer({ serverId: 's1' } as never);
    expect((sent[0] as { input: unknown }).input).toMatchObject({
      Item: { serverId: 's1' },
      ConditionExpression: 'attribute_not_exists(serverId)',
    });
  });

  it('returns one page and a cursor that continues it', async () => {
    const { client, sent } = fakeClient(() => ({ Items: [{ serverId: 's1' }], LastEvaluatedKey: { serverId: 's1' } }));
    const store = dynamoServersStore(client, 't');
    const first = await store.listServers({ limit: 1 });
    expect(first.servers.map((s) => s.serverId)).toEqual(['s1']);
    expect(first.cursor).toBeDefined();
    await store.listServers({ limit: 1, cursor: first.cursor });
    expect((sent[0] as { input: { Limit: number } }).input.Limit).toBe(1);
    expect((sent[1] as { input: { ExclusiveStartKey: unknown } }).input.ExclusiveStartKey).toEqual({ serverId: 's1' });
  });

  it('leaves destroyed servers out unless asked for them', async () => {
    const { client, sent } = fakeClient(() => ({ Items: [] }));
    const store = dynamoServersStore(client, 't');
    await store.listServers({ limit: 50 });
    expect((sent[0] as { input: unknown }).input).toMatchObject({
      FilterExpression: '#status <> :destroyed',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':destroyed': 'DESTROYED' },
    });
    await store.listServers({ limit: 50, includeDestroyed: true });
    expect((sent[1] as { input: object }).input).not.toHaveProperty('FilterExpression');
  });

  it('has no cursor on the last page', async () => {
    const { client } = fakeClient(() => ({ Items: [] }));
    expect(await dynamoServersStore(client, 't').listServers({ limit: 50 })).toEqual({ servers: [] });
  });

  it('rejects a cursor it did not issue', async () => {
    const { client } = fakeClient();
    await expect(dynamoServersStore(client, 't').listServers({ limit: 1, cursor: 'garbage' })).rejects.toBeInstanceOf(
      InvalidCursor,
    );
  });
});

describe('status timestamps and the byStatus index', () => {
  const at = new Date('2026-09-30T12:00:00Z');

  it('stamps statusChangedAt when the status changes', async () => {
    const { client, sent } = fakeClient();
    await dynamoServersStore(client, 't', () => at).transition('s1', { from: ['STOPPED'], to: 'STARTING' });
    expect((sent[0] as UpdateCommand).input.ExpressionAttributeValues).toMatchObject({ ':changedAt': at.toISOString() });
  });

  it('leaves statusChangedAt alone for a same-status write', async () => {
    const { client, sent } = fakeClient();
    await dynamoServersStore(client, 't', () => at).transition('s1', { from: ['STARTING'], to: 'STARTING', set: { volumeId: 'v' } });
    expect((sent[0] as UpdateCommand).input.UpdateExpression).not.toContain('statusChangedAt');
  });

  it('finds servers stuck in a status through the index, across pages', async () => {
    let page = 0;
    const { client, sent } = fakeClient(() =>
      page++ === 0 ? { Items: [{ serverId: 'a' }], LastEvaluatedKey: { serverId: 'a' } } : { Items: [{ serverId: 'b' }] },
    );
    const found = await dynamoServersStore(client, 't').findByStatus('STARTING', at);
    expect(found.map((s) => s.serverId)).toEqual(['a', 'b']);
    expect((sent[0] as QueryCommand).input).toMatchObject({
      IndexName: 'byStatus',
      KeyConditionExpression: '#status = :status AND statusChangedAt < :before',
      ExpressionAttributeValues: { ':status': 'STARTING', ':before': at.toISOString() },
    });
  });

  it('finds every server in a status without a time bound', async () => {
    const { client, sent } = fakeClient(() => ({ Items: [] }));
    await dynamoServersStore(client, 't').findByStatus('FAILED');
    expect((sent[0] as QueryCommand).input.KeyConditionExpression).toBe('#status = :status');
  });
});

describe('updateSettings', () => {
  it('sets only the given settings on an existing server', async () => {
    const { client, sent } = fakeClient();
    expect(await dynamoServersStore(client, 't').updateSettings('s1', { agentChannel: 'canary' })).toBe(true);
    expect((sent[0] as UpdateCommand).input).toMatchObject({
      Key: { serverId: 's1' },
      UpdateExpression: 'SET #agentChannel = :agentChannel',
      ConditionExpression: 'attribute_exists(serverId)',
      ExpressionAttributeValues: { ':agentChannel': 'canary' },
    });
  });

  it('returns false for an unknown server', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException({ message: 'no', $metadata: {} });
    });
    expect(await dynamoServersStore(client, 't').updateSettings('nope', { agentChannel: 'stable' })).toBe(false);
  });
});
