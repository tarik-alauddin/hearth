import type {
  APIGatewayProxyEventV2WithIAMAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  BACKUPS_KEPT,
  DEFAULT_AGENT_CHANNEL,
  DEFAULT_IDLE_STOP_MINUTES,
  GAME_DEFINITIONS,
  MAX_IDLE_STOP_MINUTES,
  backupKey,
  isAgentState,
  isAcceptedKey,
  isBackupKey,
  type AgentConfig,
  type AgentStatusReport,
  type ServerRecord,
} from '@hearth/shared';
import type { ServersStore } from '@hearth/core';
import type { BackupStorage } from '../backups.js';
import type { UploadStorage } from '../uploads.js';
import { AccessDenied } from '../authz.js';
import { OperationError, type serverOperations } from '../servers/operations.js';
import { callerInstanceId } from './caller.js';
import type { AgentReleases } from './releases.js';

type Event = APIGatewayProxyEventV2WithIAMAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

interface Caller {
  instanceId: string;
  server: ServerRecord;
}

export interface AgentHandlerDeps {
  store: Pick<ServersStore, 'findByInstance' | 'recordAgentReport' | 'recordBackup' | 'clearRestore'>;
  /** Names of the game instance roles allowed to call agent routes. */
  instanceRoleNames: readonly string[];
  /** Which agent release each channel points at. */
  releases: AgentReleases;
  backups: BackupStorage;
  /** Accepted uploads, restored when a server was created from one. */
  uploads: Pick<UploadStorage, 'downloadUrl'>;
  /** Server operations an agent may trigger for its own server. */
  operations: Pick<ReturnType<typeof serverOperations>, 'idleStop'>;
  now?: () => Date;
}

const MAX_VERSION_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 500;

export function agentHandlers({
  store,
  instanceRoleNames,
  releases,
  backups,
  uploads,
  operations,
  now = () => new Date(),
}: AgentHandlerDeps) {
  /** Resolves the calling instance's server, or the error response to send instead. */
  async function callerServer(event: Event): Promise<Caller | { error: Result }> {
    const instanceId = callerInstanceId(event.requestContext.authorizer.iam.userArn, instanceRoleNames);
    if (!instanceId) return { error: json(403, { message: 'Caller is not a game instance' }) };
    const server = await store.findByInstance(instanceId);
    if (!server) return { error: json(404, { message: `No server is assigned to instance ${instanceId}` }) };
    return { instanceId, server };
  }

  /** GET /agent/config */
  async function config(event: Event): Promise<Result> {
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { server } = caller;
    const game = GAME_DEFINITIONS[server.game];
    const agent = await releases.target(server.agentChannel ?? DEFAULT_AGENT_CHANNEL);
    // Not checked here: if the backup is gone, the agent's download fails and so does the start.
    const from = server.restoreSource === 'upload' ? uploads : backups;
    const restore = server.restoreKey && { key: server.restoreKey, url: await from.downloadUrl(server.restoreKey) };
    const body: AgentConfig = {
      serverId: server.serverId,
      game: server.game,
      version: server.version,
      image: game.image,
      port: game.port,
      idleStopMinutes: server.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES,
      ...(agent ? { agent } : {}),
      ...(restore ? { restore } : {}),
    };
    return json(200, body);
  }

  /** POST /agent/idle: nobody has played for a while; stop this agent's server the usual way. */
  async function idle(event: Event): Promise<Result> {
    const body = parseJsonObject(event);
    if (typeof body === 'string') return json(400, { message: body });
    const { idleMinutes } = body;
    if (typeof idleMinutes !== 'number' || !Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > MAX_IDLE_STOP_MINUTES) {
      return json(400, { message: `idleMinutes must be a whole number from 1 to ${MAX_IDLE_STOP_MINUTES}` });
    }
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { instanceId, server } = caller;
    try {
      const result = await operations.idleStop({ kind: 'agent', serverId: server.serverId, instanceId }, idleMinutes);
      console.log(JSON.stringify({ msg: 'idle stop', instanceId, idleMinutes, ...result }));
      return json(result.unchanged ? 200 : 202, result);
    } catch (err) {
      if (err instanceof OperationError || err instanceof AccessDenied) return json(err.statusCode, { message: err.message });
      throw err;
    }
  }

  /** POST /agent/restored: the game data now holds the requested backup; clear the request. */
  async function restored(event: Event): Promise<Result> {
    const body = parseJsonObject(event);
    if (typeof body === 'string') return json(400, { message: body });
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { instanceId, server } = caller;
    const { key } = body;
    // One of this server's backups, or an accepted upload (restored when the server was created from it).
    if (typeof key !== 'string' || !(isBackupKey(server.serverId, key) || isAcceptedKey(key))) {
      return json(400, { message: 'Invalid key' });
    }
    if (!(await store.clearRestore(server.serverId, instanceId, key))) {
      return json(409, { message: `No restore of ${key} pending for server ${server.serverId} on instance ${instanceId}` });
    }
    console.log(JSON.stringify({ msg: 'restore done', serverId: server.serverId, instanceId, key }));
    return { statusCode: 204 };
  }

  /** POST /agent/status */
  async function status(event: Event): Promise<Result> {
    const report = parseStatusReport(event);
    if (typeof report === 'string') return json(400, { message: report });
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { instanceId, server } = caller;
    if (!(await store.recordAgentReport(server.serverId, instanceId, report, now()))) {
      return json(409, { message: `Server ${server.serverId} is no longer on instance ${instanceId}` });
    }
    console.log(JSON.stringify({ msg: 'agent status', serverId: server.serverId, instanceId, ...report }));
    return { statusCode: 204 };
  }

  /** POST /agent/backup-credentials: where to upload a new backup, with credentials for that key only. */
  async function backupCredentials(event: Event): Promise<Result> {
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { serverId } = caller.server;
    const target = await backups.target(serverId, backupKey(serverId, now()));
    console.log(JSON.stringify({ msg: 'backup started', serverId, instanceId: caller.instanceId, key: target.key }));
    return json(200, target);
  }

  /** POST /agent/backups: the agent finished uploading a backup; record it as the newest. */
  async function backupDone(event: Event): Promise<Result> {
    const body = parseJsonObject(event);
    if (typeof body === 'string') return json(400, { message: body });
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { instanceId, server } = caller;
    const { key } = body;
    if (typeof key !== 'string' || !isBackupKey(server.serverId, key)) return json(400, { message: 'Invalid key' });
    const bytes = await backups.size(key);
    if (bytes === undefined) return json(400, { message: `No backup at ${key}` });
    if (!(await store.recordBackup(server.serverId, instanceId, { key, bytes }, now()))) {
      return json(409, { message: `Server ${server.serverId} is no longer on instance ${instanceId}` });
    }
    console.log(JSON.stringify({ msg: 'backup done', serverId: server.serverId, instanceId, key, bytes }));

    // The backup is recorded either way; a failed prune is retried by the next backup.
    try {
      const pruned = await backups.prune(server.serverId, BACKUPS_KEPT);
      if (pruned.length) console.log(JSON.stringify({ msg: 'old backups pruned', serverId: server.serverId, pruned }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'pruning old backups failed', serverId: server.serverId, err: String(err) }));
    }
    return { statusCode: 204 };
  }

  return { config, status, backupCredentials, backupDone, restored, idle };
}

/** The request body as a JSON object, or an error message. */
function parseJsonObject(event: Event): Record<string, unknown> | string {
  let body: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw ?? '');
  } catch {
    return 'Body must be JSON';
  }
  if (typeof body !== 'object' || body === null) return 'Body must be a JSON object';
  return body as Record<string, unknown>;
}

/** The validated report, or an error message. */
function parseStatusReport(event: Event): AgentStatusReport | string {
  const body = parseJsonObject(event);
  if (typeof body === 'string') return body;
  const { state, agentVersion, message } = body;
  if (!isAgentState(state)) return 'Invalid state';
  if (typeof agentVersion !== 'string' || !agentVersion || agentVersion.length > MAX_VERSION_LENGTH) {
    return 'Invalid agentVersion';
  }
  if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) {
    return 'Invalid message';
  }
  return message === undefined ? { state, agentVersion } : { state, agentVersion, message };
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
