import { InvalidCursor, newId as defaultNewId, type ServersStore } from '@hearth/core';
import {
  AGENT_CHANNELS,
  DEFAULT_AGENT_CHANNEL,
  GAMES,
  backupPrefix,
  isAgentChannel,
  type CreateServerRequest,
  type GameId,
  type ListBackupsResponse,
  type ListServersResponse,
  type RestoreRequest,
  type ServerOperationResult,
  type ServerRecord,
  type ServerStatus,
  type UpdateSettingsRequest,
} from '@hearth/shared';
import type { BackupStorage } from '../backups.js';

// The one implementation of create, start and stop. The admin routes use it now; the UI and
// Discord bot routes will call the same functions, so every caller behaves the same.

export type WorkflowName = 'create' | 'start' | 'stop';

export interface Workflows {
  /** Starts a workflow execution named after the operation, so the same claim can't run twice. */
  start(workflow: WorkflowName, serverId: string, operationId: string): Promise<void>;
}

/** An expected failure with the HTTP status to answer with. */
export class OperationError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OperationDeps {
  store: Pick<ServersStore, 'getServer' | 'listServers' | 'createServer' | 'transition' | 'updateSettings'>;
  workflows: Workflows;
  backups: Pick<BackupStorage, 'list'>;
  homeRegion: string;
  /** Regions with game infrastructure. */
  gameRegions: readonly string[];
  now?: () => Date;
  newId?: (now: Date) => string;
}

const VERSION = /^[0-9A-Za-z._-]{1,32}$/;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

export function serverOperations({
  store,
  workflows,
  backups,
  homeRegion,
  gameRegions,
  now = () => new Date(),
  newId = defaultNewId,
}: OperationDeps) {
  async function requireServer(serverId: string): Promise<ServerRecord> {
    const server = await store.getServer(serverId);
    if (!server) throw new OperationError(404, `No server ${serverId}`);
    return server;
  }

  /**
   * Claims `from → to`, then starts the workflow. If the workflow can't start, the claim is undone
   * (back to the previous status, or FAILED for a new server) so the server isn't stuck.
   */
  async function claimAndRun(
    server: ServerRecord,
    workflow: WorkflowName,
    from: readonly ServerStatus[],
    to: ServerStatus,
  ): Promise<ServerOperationResult> {
    const operationId = newId(now());
    const claimed = await store.transition(server.serverId, {
      from,
      to,
      ...(server.instanceId ? { instanceId: server.instanceId } : {}),
      set: { lastOperationId: operationId },
    });
    if (!claimed) {
      // Lost a race: if another request already made the same claim, this one is a no-op.
      const current = await store.getServer(server.serverId);
      if (current?.status === to) return { serverId: server.serverId, status: to, unchanged: true };
      throw new OperationError(409, `Server ${server.serverId} changed state; try again`);
    }
    await run(server.serverId, workflow, operationId, to, server.status);
    return { serverId: server.serverId, status: to };
  }

  async function run(serverId: string, workflow: WorkflowName, operationId: string, claimed: ServerStatus, previous: ServerStatus) {
    try {
      await workflows.start(workflow, serverId, operationId);
    } catch (err) {
      const undo = previous === claimed ? 'FAILED' : previous;
      await store.transition(serverId, {
        from: [claimed],
        to: undo,
        set: undo === 'FAILED' ? { statusMessage: `Couldn't start the ${workflow} workflow` } : {},
      });
      throw err;
    }
  }

  return {
    getServer: requireServer,

    /** One page of servers: `limit` 1–100 (default 50), `cursor` from the previous page. */
    async listServers(limit: string | undefined, cursor: string | undefined): Promise<ListServersResponse> {
      const size = limit === undefined ? DEFAULT_PAGE : Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw new OperationError(400, `limit must be 1–${MAX_PAGE}`);
      try {
        return await store.listServers({ limit: size, ...(cursor ? { cursor } : {}) });
      } catch (err) {
        if (err instanceof InvalidCursor) throw new OperationError(400, 'Invalid cursor');
        throw err;
      }
    },

    /** Records a new server (PROVISIONING) and runs the create workflow, which also starts it. */
    async createServer(request: unknown, ownerId: string): Promise<ServerOperationResult> {
      const { game, version, region = homeRegion, agentChannel = DEFAULT_AGENT_CHANNEL } = validateCreate(request);
      if (!gameRegions.includes(region)) throw new OperationError(400, `No game infrastructure in ${region}`);
      const at = now();
      const serverId = newId(at);
      const operationId = newId(at);
      await store.createServer({
        serverId,
        ownerId,
        game,
        region,
        status: 'PROVISIONING',
        version,
        autoUpdate: false,
        agentChannel,
        createdAt: at.toISOString(),
        statusChangedAt: at.toISOString(),
        lastOperationId: operationId,
      });
      await run(serverId, 'create', operationId, 'PROVISIONING', 'PROVISIONING');
      return { serverId, status: 'PROVISIONING' };
    },

    /** STOPPED or FAILED → STARTING. A server whose create failed before launch is created again. */
    async startServer(serverId: string): Promise<ServerOperationResult> {
      const server = await requireServer(serverId);
      if (['RUNNING', 'STARTING', 'PROVISIONING'].includes(server.status)) {
        return { serverId, status: server.status, unchanged: true };
      }
      if (server.status === 'FAILED' && !server.instanceId) {
        return claimAndRun(server, 'create', ['FAILED'], 'PROVISIONING');
      }
      if (server.status === 'STOPPED' || server.status === 'FAILED') {
        return claimAndRun(server, 'start', ['STOPPED', 'FAILED'], 'STARTING');
      }
      throw new OperationError(409, `Server ${serverId} is ${server.status} and can't be started`);
    },

    /** Changes settings; they apply from the server's next start. */
    async updateSettings(serverId: string, request: unknown): Promise<ServerRecord> {
      const settings = validateSettings(request);
      if (!(await store.updateSettings(serverId, settings))) throw new OperationError(404, `No server ${serverId}`);
      return requireServer(serverId);
    },

    /** RUNNING or FAILED (with an instance) → STOPPING. */
    async stopServer(serverId: string): Promise<ServerOperationResult> {
      const server = await requireServer(serverId);
      if (server.status === 'STOPPED' || server.status === 'STOPPING') {
        return { serverId, status: server.status, unchanged: true };
      }
      if (server.status === 'RUNNING' || (server.status === 'FAILED' && server.instanceId)) {
        return claimAndRun(server, 'stop', ['RUNNING', 'FAILED'], 'STOPPING');
      }
      throw new OperationError(409, `Server ${serverId} is ${server.status} and can't be stopped`);
    },

    /** The server's backups, newest first. */
    async listBackups(serverId: string): Promise<ListBackupsResponse> {
      await requireServer(serverId); // 404 for an unknown server, not an empty list
      return { backups: await backups.list(serverId) };
    },

    /**
     * Asks for a backup (default: the newest) to replace the world on the next start. Only while
     * STOPPED, and not after an unclean stop unless forced: that world may be in no backup.
     */
    async requestRestore(serverId: string, request: unknown): Promise<ServerRecord> {
      const { key, force } = validateRestore(request);
      const server = await requireServer(serverId);
      if (server.status !== 'STOPPED') {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; stop it before restoring`);
      }
      if (server.lastStopClean === false && !force) {
        throw new OperationError(
          409,
          `Server ${serverId}'s last stop wasn't clean, so its current world may be in no backup; force to restore anyway`,
        );
      }
      const available = await backups.list(serverId);
      if (available.length === 0) throw new OperationError(409, `Server ${serverId} has no backups`);
      const wanted = key === undefined ? available[0]!.key : key.includes('/') ? key : `${backupPrefix(serverId)}${key}`;
      if (!available.some((b) => b.key === wanted)) throw new OperationError(404, `No backup ${wanted}`);

      const ok = await store.transition(serverId, {
        from: ['STOPPED'],
        to: 'STOPPED',
        set: { restoreKey: wanted, restoreRequestedAt: now().toISOString() },
      });
      if (!ok) throw new OperationError(409, `Server ${serverId} changed state; try again`);
      return requireServer(serverId);
    },

    /** Clears a requested restore. Only while STOPPED: once starting, the restore may be under way. */
    async cancelRestore(serverId: string): Promise<ServerRecord> {
      const server = await requireServer(serverId);
      if (!server.restoreKey) return server;
      const ok = await store.transition(serverId, {
        from: ['STOPPED'],
        to: 'STOPPED',
        remove: ['restoreKey', 'restoreRequestedAt'],
      });
      if (!ok) throw new OperationError(409, `Server ${serverId} is no longer stopped; the restore can't be cancelled`);
      return requireServer(serverId);
    },
  };
}

function validateRestore(request: unknown): RestoreRequest {
  if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
  const { key, force, ...rest } = request as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new OperationError(400, `Unknown fields: ${unknown.join(', ')}`);
  if (key !== undefined && (typeof key !== 'string' || !key)) throw new OperationError(400, 'Invalid key');
  if (force !== undefined && typeof force !== 'boolean') throw new OperationError(400, 'force must be true or false');
  return { ...(key !== undefined ? { key } : {}), ...(force ? { force } : {}) };
}

function validateCreate(request: unknown): CreateServerRequest {
  if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
  const { game, version, region } = request as Record<string, unknown>;
  if (!(GAMES as readonly unknown[]).includes(game)) throw new OperationError(400, `Unknown game; one of ${GAMES.join(', ')}`);
  if (typeof version !== 'string' || !VERSION.test(version)) throw new OperationError(400, 'Invalid version');
  if (region !== undefined && typeof region !== 'string') throw new OperationError(400, 'Invalid region');
  const { agentChannel } = request as Record<string, unknown>;
  if (agentChannel !== undefined && !isAgentChannel(agentChannel)) {
    throw new OperationError(400, `agentChannel must be one of ${AGENT_CHANNELS.join(', ')}`);
  }
  return { game: game as GameId, version, ...(region ? { region } : {}), ...(agentChannel ? { agentChannel } : {}) };
}

function validateSettings(request: unknown): UpdateSettingsRequest {
  if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
  const { agentChannel, ...rest } = request as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new OperationError(400, `Unknown settings: ${unknown.join(', ')}`);
  if (agentChannel === undefined) throw new OperationError(400, 'No settings given');
  if (!isAgentChannel(agentChannel)) throw new OperationError(400, `agentChannel must be one of ${AGENT_CHANNELS.join(', ')}`);
  return { agentChannel };
}
