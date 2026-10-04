import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  SERVERS_BY_INSTANCE_INDEX,
  SERVERS_BY_STATUS_INDEX,
  type AgentStatusReport,
  type InstanceState,
  type ServerRecord,
  type ServerStatus,
} from '@hearth/shared';

/**
 * Every read and write of the Servers table. Status changes are conditional transitions, so the
 * rules about which state may follow which live here and nowhere else.
 */
export interface ServersStore {
  /** Strongly consistent read of one server. */
  getServer(serverId: string): Promise<ServerRecord | undefined>;
  /** One page of servers (admin use: a scan). Pass the returned cursor to get the next page. */
  listServers(page: { limit: number; cursor?: string }): Promise<{ servers: ServerRecord[]; cursor?: string }>;
  /** Writes a new record; fails if the ID is taken. */
  createServer(server: ServerRecord): Promise<void>;
  /** API: changes user settings on an existing server. Returns false if there's no such server. */
  updateSettings(serverId: string, settings: ServerSettings): Promise<boolean>;
  findByInstance(instanceId: string): Promise<ServerRecord | undefined>;
  /**
   * Servers in `status` (from the byStatus index: keys, statusChangedAt, instanceId, instanceState),
   * optionally only those that have been in it since before `changedBefore`.
   */
  findByStatus(status: ServerStatus, changedBefore?: Date): Promise<StatusIndexEntry[]>;
  /** Agent routes. Returns false if the server is no longer on this instance. */
  recordAgentReport(serverId: string, instanceId: string, report: AgentStatusReport, at: Date): Promise<boolean>;
  /** Agent routes: records a finished backup. Returns false if the server is no longer on this instance. */
  recordBackup(serverId: string, instanceId: string, backup: { key: string; bytes: number }, at: Date): Promise<boolean>;
  /**
   * State sync: records what EC2 says about the server's instance. Returns false if the server is
   * no longer on this instance, or a newer state is already recorded (events arrive out of order).
   */
  recordInstanceState(
    serverId: string,
    instanceId: string,
    state: InstanceState,
    at: Date,
    publicIp?: string,
  ): Promise<boolean>;
  /** Moves `status` to `to` only if it's currently one of `from`. Returns false if it wasn't. */
  transition(serverId: string, change: Transition): Promise<boolean>;
}

/** Settings owners can change (more arrive with the UI). */
export type ServerSettings = Partial<Pick<ServerRecord, 'agentChannel'>>;

export type StatusIndexEntry = Pick<ServerRecord, 'serverId' | 'status' | 'statusChangedAt' | 'instanceId' | 'instanceState'>;

export interface Transition {
  from: readonly ServerStatus[];
  to: ServerStatus;
  /** Also require the server to still be on this instance. */
  instanceId?: string;
  /** Fields to set in the same write. */
  set?: Partial<Omit<ServerRecord, 'serverId' | 'status'>>;
  /** Fields to remove in the same write. */
  remove?: readonly (keyof ServerRecord)[];
}

export function createServersStore(tableName: string): ServersStore {
  return dynamoServersStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName);
}

export function dynamoServersStore(
  client: Pick<DynamoDBDocumentClient, 'send'>,
  tableName: string,
  now: () => Date = () => new Date(),
): ServersStore {
  /** Runs a conditional update; false when the condition didn't hold. */
  async function conditionalUpdate(input: Omit<UpdateCommandInput, 'TableName'>): Promise<boolean> {
    try {
      await client.send(new UpdateCommand({ TableName: tableName, ...input }));
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }

  return {
    async getServer(serverId) {
      const { Item } = await client.send(new GetCommand({ TableName: tableName, Key: { serverId }, ConsistentRead: true }));
      return Item as ServerRecord | undefined;
    },

    async listServers({ limit, cursor }) {
      const out = await client.send(
        new ScanCommand({ TableName: tableName, Limit: limit, ExclusiveStartKey: cursor ? decodeCursor(cursor) : undefined }),
      );
      const next = out.LastEvaluatedKey ? encodeCursor(out.LastEvaluatedKey) : undefined;
      return { servers: (out.Items ?? []) as ServerRecord[], ...(next ? { cursor: next } : {}) };
    },

    async createServer(server) {
      await client.send(
        new PutCommand({ TableName: tableName, Item: server, ConditionExpression: 'attribute_not_exists(serverId)' }),
      );
    },

    async updateSettings(serverId, settings) {
      const entries = Object.entries(settings).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return true;
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${entries.map(([field]) => `#${field} = :${field}`).join(', ')}`,
        ConditionExpression: 'attribute_exists(serverId)',
        ExpressionAttributeNames: Object.fromEntries(entries.map(([field]) => [`#${field}`, field])),
        ExpressionAttributeValues: Object.fromEntries(entries.map(([field, value]) => [`:${field}`, value])),
      });
    },

    async findByStatus(status, changedBefore) {
      const entries: StatusIndexEntry[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await client.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: SERVERS_BY_STATUS_INDEX,
            KeyConditionExpression: changedBefore ? '#status = :status AND statusChangedAt < :before' : '#status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':status': status,
              ...(changedBefore ? { ':before': changedBefore.toISOString() } : {}),
            },
            ExclusiveStartKey: start,
          }),
        );
        entries.push(...((out.Items ?? []) as StatusIndexEntry[]));
        start = out.LastEvaluatedKey;
      } while (start);
      return entries;
    },

    async findByInstance(instanceId) {
      const { Items = [] } = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: SERVERS_BY_INSTANCE_INDEX,
          KeyConditionExpression: 'instanceId = :instanceId',
          ExpressionAttributeValues: { ':instanceId': instanceId },
          Limit: 2,
        }),
      );
      if (Items.length > 1) throw new Error(`More than one server has instance ${instanceId}`);
      return Items[0] as ServerRecord | undefined;
    },

    async recordAgentReport(serverId, instanceId, report, at) {
      const set = ['agentState = :state', 'agentVersion = :version', 'agentReportedAt = :at'];
      const values: Record<string, unknown> = {
        ':state': report.state,
        ':version': report.agentVersion,
        ':at': at.toISOString(),
        ':instanceId': instanceId,
      };
      if (report.message !== undefined) {
        set.push('agentMessage = :message');
        values[':message'] = report.message;
      }
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${set.join(', ')}${report.message === undefined ? ' REMOVE agentMessage' : ''}`,
        // The index is eventually consistent; only write if the server is still on this instance.
        ConditionExpression: 'instanceId = :instanceId',
        ExpressionAttributeValues: values,
      });
    },

    async recordBackup(serverId, instanceId, { key, bytes }, at) {
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: 'SET lastBackupKey = :key, lastBackupBytes = :bytes, lastBackupAt = :at',
        ConditionExpression: 'instanceId = :instanceId',
        ExpressionAttributeValues: { ':key': key, ':bytes': bytes, ':at': at.toISOString(), ':instanceId': instanceId },
      });
    },

    async recordInstanceState(serverId, instanceId, state, at, publicIp) {
      const set = ['instanceState = :state', 'instanceStateAt = :at'];
      const remove: string[] = [];
      const values: Record<string, unknown> = { ':state': state, ':at': at.toISOString(), ':instanceId': instanceId };
      if (state === 'running') set.push('lastStartedAt = :at');
      if (state === 'stopped') set.push('lastStoppedAt = :at');
      // A public IP only means something while the instance runs; each start gets a new one.
      if (state === 'running' && publicIp) {
        set.push('publicIp = :publicIp');
        values[':publicIp'] = publicIp;
      } else {
        remove.push('publicIp');
      }
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${set.join(', ')}${remove.length ? ` REMOVE ${remove.join(', ')}` : ''}`,
        ConditionExpression:
          'instanceId = :instanceId AND (attribute_not_exists(instanceStateAt) OR instanceStateAt < :at)',
        ExpressionAttributeValues: values,
      });
    },

    async transition(serverId, { from, to, instanceId, set = {}, remove = [] }) {
      if (from.length === 0) throw new Error('transition needs at least one from status');
      const values: Record<string, unknown> = { ':to': to };
      const names: Record<string, string> = { '#status': 'status' };
      const sets = ['#status = :to'];
      // A same-status write (e.g. recording the volume while STARTING) isn't a status change.
      if (!(from.length === 1 && from[0] === to)) {
        sets.push('statusChangedAt = :changedAt');
        values[':changedAt'] = now().toISOString();
      }
      // Prefixed placeholders, so a field being set can't collide with the condition's.
      for (const [field, value] of Object.entries(set)) {
        names[`#set_${field}`] = field;
        values[`:set_${field}`] = value;
        sets.push(`#set_${field} = :set_${field}`);
      }
      const removes = remove.map((field) => {
        names[`#rm_${String(field)}`] = String(field);
        return `#rm_${String(field)}`;
      });
      const allowed = from.map((status, i) => {
        values[`:from${i}`] = status;
        return `:from${i}`;
      });
      let condition = `#status IN (${allowed.join(', ')})`;
      if (instanceId !== undefined) {
        condition += ' AND instanceId = :instanceId';
        values[':instanceId'] = instanceId;
      }
      return conditionalUpdate({
        Key: { serverId },
        UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      });
    },
  };
}

/** Thrown for a cursor that wasn't returned by listServers. */
export class InvalidCursor extends Error {}

// A cursor is the scan's last key (just the serverId), base64url-encoded so it's opaque to callers.
function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ serverId: key.serverId })).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { serverId?: unknown };
    if (typeof key.serverId === 'string' && key.serverId) return { serverId: key.serverId };
  } catch {
    // fall through
  }
  throw new InvalidCursor('Invalid cursor');
}
