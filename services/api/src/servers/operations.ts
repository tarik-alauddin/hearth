import { InvalidCursor, newId as defaultNewId, type ServersStore, type Transition } from '@hearth/core';
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
  type SetVersionRequest,
  type UpdateSettingsRequest,
} from '@hearth/shared';
import type { BackupStorage } from '../backups.js';
import type { GameVersions } from './versions.js';

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
  versions: GameVersions;
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
  versions,
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
    change: Pick<Transition, 'set' | 'remove'> = {},
  ): Promise<ServerOperationResult> {
    const operationId = newId(now());
    const claimed = await store.transition(server.serverId, {
      from,
      to,
      ...(server.instanceId ? { instanceId: server.instanceId } : {}),
      set: { ...change.set, lastOperationId: operationId },
      ...(change.remove ? { remove: change.remove } : {}),
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
        return claimAndRun(server, 'stop', ['RUNNING', 'FAILED'], 'STOPPING', { remove: ['stopReason'] });
      }
      throw new OperationError(409, `Server ${serverId} is ${server.status} and can't be stopped`);
    },

    /**
     * The agent on `instanceId` found nobody playing for `idleMinutes`: RUNNING → STOPPING, through
     * the same stop workflow (so the world is still saved and backed up), recording why.
     */
    async idleStop(serverId: string, instanceId: string, idleMinutes: number): Promise<ServerOperationResult> {
      const server = await requireServer(serverId);
      if (server.instanceId !== instanceId) {
        throw new OperationError(409, `Server ${serverId} is no longer on instance ${instanceId}`);
      }
      if (server.status === 'STOPPED' || server.status === 'STOPPING') {
        return { serverId, status: server.status, unchanged: true };
      }
      if (server.status !== 'RUNNING') {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; only a running server is stopped for being idle`);
      }
      const minutes = idleMinutes === 1 ? '1 minute' : `${idleMinutes} minutes`;
      return claimAndRun(server, 'stop', ['RUNNING'], 'STOPPING', { set: { stopReason: `no players for ${minutes}` } });
    },

    /**
     * Moves a stopped server to a newer release of its game, from its next start. Forward only:
     * the game converts the world on load, and older versions can't read it back. Needs a clean
     * last stop with a backup since the server last ran, so the world before the upgrade is kept.
     */
    async setVersion(serverId: string, request: unknown): Promise<ServerRecord> {
      const { version } = validateSetVersion(request);
      const server = await requireServer(serverId);
      if (server.version === version) return server;
      if (server.status !== 'STOPPED') {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; stop it before changing its version`);
      }

      const releases = await versions.releases(server.game);
      if (!releases) throw new OperationError(400, `Changing the version isn't supported for ${server.game}`);
      const to = releases.indexOf(version);
      if (to === -1) throw new OperationError(400, `${version} is not a release of ${server.game}`);
      const from = releases.indexOf(server.version);
      if (from === -1) {
        throw new OperationError(409, `Can't tell whether ${version} is newer than ${server.version}, which isn't a known release`);
      }
      if (to < from) {
        throw new OperationError(
          409,
          `${version} is older than ${server.version}; versions only move forward (the game upgrades the world)`,
        );
      }

      const backedUp =
        server.lastStopClean === true &&
        server.lastBackupAt !== undefined &&
        // Parsed: lastStartedAt comes from EC2 events, without milliseconds.
        (server.lastStartedAt === undefined || Date.parse(server.lastBackupAt) > Date.parse(server.lastStartedAt));
      if (!backedUp) {
        throw new OperationError(
          409,
          `Server ${serverId} has no backup since it last ran; start and stop it once (a clean stop takes one)`,
        );
      }

      // A same-status write: it only lands if no start got in first.
      const ok = await store.transition(serverId, { from: ['STOPPED'], to: 'STOPPED', set: { version } });
      if (!ok) throw new OperationError(409, `Server ${serverId} changed state; try again`);
      return requireServer(serverId);
    },

    /** The server's backups, newest first. */
    async listBackups(serverId: string): Promise<ListBackupsResponse> {
      await requireServer(serverId); // 404 for an unknown server, not an empty list
      return { backups: await backups.list(serverId) };
    },

    /**
     * Asks for a backup (default: the newest) to replace the world on the next start. Only while
     * stopped (see `restorable`), and not after an unclean stop unless forced: that world may be in
     * no backup.
     */
    async requestRestore(serverId: string, request: unknown): Promise<ServerRecord> {
      const { key, force } = validateRestore(request);
      const server = await requireServer(serverId);
      if (!restorable(server)) {
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

      // A same-status write: it only lands if no start or stop got in first.
      const ok = await store.transition(serverId, {
        from: [server.status],
        to: server.status,
        set: { restoreKey: wanted, restoreRequestedAt: now().toISOString() },
      });
      if (!ok) throw new OperationError(409, `Server ${serverId} changed state; try again`);
      return requireServer(serverId);
    },

    /** Clears a requested restore. Only while stopped: once starting, the restore may be under way. */
    async cancelRestore(serverId: string): Promise<ServerRecord> {
      const server = await requireServer(serverId);
      if (!server.restoreKey) return server;
      if (!restorable(server)) {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; the restore can't be cancelled now`);
      }
      const ok = await store.transition(serverId, {
        from: [server.status],
        to: server.status,
        remove: ['restoreKey', 'restoreRequestedAt'],
      });
      if (!ok) throw new OperationError(409, `Server ${serverId} is no longer stopped; the restore can't be cancelled`);
      return requireServer(serverId);
    },
  };
}

/**
 * Whether a restore may be requested or cancelled: the server is STOPPED, or FAILED with its
 * instance stopped (a failed start, e.g. one whose backup was gone) or never launched.
 */
function restorable(server: ServerRecord): boolean {
  if (server.status === 'STOPPED') return true;
  return server.status === 'FAILED' && (!server.instanceId || server.instanceState === 'stopped');
}

function validateSetVersion(request: unknown): SetVersionRequest {
  if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
  const { version, ...rest } = request as Record<string, unknown>;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new OperationError(400, `Unknown fields: ${unknown.join(', ')}`);
  if (typeof version !== 'string' || !VERSION.test(version)) throw new OperationError(400, 'Invalid version');
  return { version };
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
