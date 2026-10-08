import { InvalidCursor, newId as defaultNewId, type AccessStore, type ServersStore, type Transition } from '@hearth/core';
import {
  DEFAULT_AGENT_CHANNEL,
  backupPrefix,
  isUploadId,
  type GameId,
  type ListBackupsResponse,
  type ListServersResponse,
  type ServerOperationResult,
  type ServerAction,
  type ServerRecord,
  type ServerStatus,
} from '@hearth/shared';
import {
  CreateServerRequestSchema,
  RestoreRequestSchema,
  SetVersionRequestSchema,
  UpdateSettingsRequestSchema,
} from '@hearth/shared/api';
import type { z } from 'zod';
import { actorId, requireAdmin, serverAuthorizer, type Actor, type Relation } from '../authz.js';
import { check } from '../validation.js';
import type { BackupStorage } from '../backups.js';
import type { UploadStorage } from '../uploads.js';
import type { GameVersions } from './versions.js';

// The one implementation of every server operation. The admin routes use it now; the UI and
// Discord bot routes will call the same functions, so every caller behaves the same. Each takes
// the actor first and checks it (`authorize`) before reading or changing anything.

export type WorkflowName = 'create' | 'start' | 'stop' | 'destroy';

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
  /** Users' access to servers. Only routes for signed-in users (/v1) need it; others have no user callers. */
  access?: Pick<AccessStore, 'getAccess' | 'listForUser'>;
  workflows: Workflows;
  backups: Pick<BackupStorage, 'list'>;
  uploads: Pick<UploadStorage, 'status' | 'accepted'>;
  versions: GameVersions;
  homeRegion: string;
  /** Regions with game infrastructure. */
  gameRegions: readonly string[];
  now?: () => Date;
  newId?: (now: Date) => string;
}

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

export function serverOperations({
  store,
  access,
  workflows,
  backups,
  uploads,
  versions,
  homeRegion,
  gameRegions,
  now = () => new Date(),
  newId = defaultNewId,
}: OperationDeps) {
  const authorize = serverAuthorizer(access);

  async function requireServer(serverId: string): Promise<ServerRecord> {
    const server = await store.getServer(serverId);
    if (!server) throw new OperationError(404, `No server ${serverId}`);
    return server;
  }

  /** Checks the actor may do `action` to the server, then reads it (404 either way if not). */
  async function serverFor(actor: Actor, action: ServerAction, serverId: string): Promise<ServerRecord> {
    await authorize(actor, action, serverId);
    return requireServer(serverId);
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

  /** Refuses an upload repack hasn't accepted, or accepted for another game. */
  async function requireAccepted(uploadId: string, game: GameId): Promise<void> {
    const status = isUploadId(uploadId) ? await uploads.status(uploadId) : undefined;
    if (!status) throw new OperationError(404, `No upload ${uploadId} (never uploaded, or expired)`);
    if (status.status === 'repacking') throw new OperationError(409, `Upload ${uploadId} is still being checked; try again shortly`);
    if (status.status === 'rejected') throw new OperationError(409, `Upload ${uploadId} was rejected: ${status.reason}`);
    if (status.game && status.game !== game) throw new OperationError(409, `Upload ${uploadId} is for ${status.game}, not ${game}`);
  }

  return {
    /** The server, and what the caller is to it (for shaping the response). */
    async getServer(actor: Actor, serverId: string): Promise<{ server: ServerRecord; relation: Relation }> {
      const relation = await authorize(actor, 'view', serverId);
      return { server: await requireServer(serverId), relation };
    },

    /**
     * The servers a signed-in user (or an admin, as a user) owns or is a member of, newest first,
     * each with their role on it. Destroyed ones only with `all`. Every server through the
     * caller's own access: nothing here can reach a server they have no row for.
     */
    async listMyServers(actor: Actor, all = false): Promise<{ server: ServerRecord; relation: Relation }[]> {
      if (actor.kind === 'agent') throw new OperationError(403, 'Agents have no servers to list');
      if (!access) throw new Error('No access store: this route takes no user callers');
      const rows = await access.listForUser(actorId(actor));
      const found = await Promise.all(
        rows.map(async (row) => ({ server: await store.getServer(row.serverId), relation: row.role as Relation })),
      );
      return found
        .filter((f): f is { server: ServerRecord; relation: Relation } => f.server !== undefined)
        .filter((f) => all || f.server.status !== 'DESTROYED')
        .sort((a, b) => (b.server.createdAt ?? '').localeCompare(a.server.createdAt ?? ''));
    },

    /**
     * Admins: one page of every server: `limit` 1–100 (default 50), `cursor` from the previous
     * page; destroyed ones only with `all`. (A user's own list comes from their access, with /v1.)
     */
    async listServers(actor: Actor, limit: string | undefined, cursor: string | undefined, all = false): Promise<ListServersResponse> {
      requireAdmin(actor);
      const size = limit === undefined ? DEFAULT_PAGE : Number(limit);
      if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw new OperationError(400, `limit must be 1–${MAX_PAGE}`);
      try {
        return await store.listServers({ limit: size, ...(cursor ? { cursor } : {}), ...(all ? { includeDestroyed: true } : {}) });
      } catch (err) {
        if (err instanceof InvalidCursor) throw new OperationError(400, 'Invalid cursor');
        throw err;
      }
    },

    /**
     * Records a new server (PROVISIONING), owned by the actor, and runs the create workflow, which
     * also starts it. Admins only for now: users create through /v1, which adds the approval and
     * server-cap checks and records the owner's access with the server.
     */
    async createServer(actor: Actor, request: unknown): Promise<ServerOperationResult> {
      requireAdmin(actor);
      const ownerId = actorId(actor);
      const { game, version, region = homeRegion, agentChannel = DEFAULT_AGENT_CHANNEL, upload } = parse(CreateServerRequestSchema, request);
      if (!gameRegions.includes(region)) throw new OperationError(400, `No game infrastructure in ${region}`);
      if (upload !== undefined) await requireAccepted(upload, game);
      const at = now();
      const serverId = newId(at);
      const operationId = newId(at);

      // Starting from an upload: restore the accepted file, straight from the uploads bucket, on the
      // first start (M5's restore path). No copy: copying gigabytes doesn't fit in an API request.
      // The server's first stop backs it up; an upload left unstarted past its 7-day expiry fails
      // that first start, visibly.
      const restore: Pick<ServerRecord, 'restoreKey' | 'restoreSource' | 'restoreRequestedAt'> =
        upload === undefined
          ? {}
          : { restoreKey: uploads.accepted(upload).key, restoreSource: 'upload', restoreRequestedAt: at.toISOString() };

      await store.createServer({
        ...restore,
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
    async startServer(actor: Actor, serverId: string): Promise<ServerOperationResult> {
      const server = await serverFor(actor, 'start', serverId);
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
    async updateSettings(actor: Actor, serverId: string, request: unknown): Promise<ServerRecord> {
      const settings = parse(UpdateSettingsRequestSchema, request);
      // Which agent releases a server follows is an admin's call: it's how releases are tried out.
      if (settings.agentChannel !== undefined) requireAdmin(actor);
      if ((await serverFor(actor, 'settings', serverId)).status === 'DESTROYED') {
        throw new OperationError(409, `Server ${serverId} is DESTROYED; its settings can't change`);
      }
      if (!(await store.updateSettings(serverId, settings))) throw new OperationError(404, `No server ${serverId}`);
      return requireServer(serverId);
    },

    /** RUNNING or FAILED (with an instance) → STOPPING. */
    async stopServer(actor: Actor, serverId: string): Promise<ServerOperationResult> {
      const server = await serverFor(actor, 'stop', serverId);
      if (server.status === 'STOPPED' || server.status === 'STOPPING') {
        return { serverId, status: server.status, unchanged: true };
      }
      if (server.status === 'RUNNING' || (server.status === 'FAILED' && server.instanceId)) {
        return claimAndRun(server, 'stop', ['RUNNING', 'FAILED'], 'STOPPING', { remove: ['stopReason'] });
      }
      throw new OperationError(409, `Server ${serverId} is ${server.status} and can't be stopped`);
    },

    /**
     * STOPPED, or FAILED with its instance not running → DESTROYING, and the destroy workflow
     * removes its instance, data volume and record. Its backups are kept. Never a running server:
     * stopping it first also saves and backs it up.
     */
    async destroyServer(actor: Actor, serverId: string): Promise<ServerOperationResult> {
      const server = await serverFor(actor, 'destroy', serverId);
      if (server.status === 'DESTROYING' || server.status === 'DESTROYED') return { serverId, status: server.status, unchanged: true };
      const instanceUp = server.instanceState === 'running' || server.instanceState === 'pending';
      if (server.status === 'STOPPED' || (server.status === 'FAILED' && !instanceUp)) {
        return claimAndRun(server, 'destroy', [server.status], 'DESTROYING');
      }
      const why = server.status === 'FAILED' ? 'is FAILED but its instance is still running' : `is ${server.status}`;
      throw new OperationError(409, `Server ${serverId} ${why}; stop it before destroying it`);
    },

    /**
     * The agent found nobody playing for `idleMinutes`: RUNNING → STOPPING, through the same stop
     * workflow (so the game is still saved and backed up), recording why. The agent may only stop
     * its own server.
     */
    async idleStop(agent: Extract<Actor, { kind: 'agent' }>, idleMinutes: number): Promise<ServerOperationResult> {
      const { serverId, instanceId } = agent;
      const server = await serverFor(agent, 'stop', serverId);
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
     * the game converts its data on load, and older versions can't read it back. Needs a clean
     * last stop with a backup since the server last ran, so the data before the upgrade is kept.
     */
    async setVersion(actor: Actor, serverId: string, request: unknown): Promise<ServerRecord> {
      const { version } = parse(SetVersionRequestSchema, request);
      const server = await serverFor(actor, 'version', serverId);
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
          `${version} is older than ${server.version}; versions only move forward (the game upgrades its data)`,
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
    async listBackups(actor: Actor, serverId: string): Promise<ListBackupsResponse> {
      await serverFor(actor, 'backups', serverId); // 404 for an unknown server, not an empty list
      return { backups: await backups.list(serverId) };
    },

    /**
     * Asks for a backup (default: the newest) to replace the game data on the next start. Only while
     * stopped (see `restorable`), and not after an unclean stop unless forced: that data may be in
     * no backup.
     */
    async requestRestore(actor: Actor, serverId: string, request: unknown): Promise<ServerRecord> {
      const { key, force } = parse(RestoreRequestSchema, request);
      const server = await serverFor(actor, 'restore', serverId);
      if (!restorable(server)) {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; stop it before restoring`);
      }
      if (server.lastStopClean === false && !force) {
        throw new OperationError(
          409,
          `Server ${serverId}'s last stop wasn't clean, so its current game data may be in no backup; force to restore anyway`,
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
        remove: ['restoreSource'], // a backup, replacing any pending upload
      });
      if (!ok) throw new OperationError(409, `Server ${serverId} changed state; try again`);
      return requireServer(serverId);
    },

    /** Clears a requested restore. Only while stopped: once starting, the restore may be under way. */
    async cancelRestore(actor: Actor, serverId: string): Promise<ServerRecord> {
      const server = await serverFor(actor, 'restore', serverId);
      if (!server.restoreKey) return server;
      if (!restorable(server)) {
        throw new OperationError(409, `Server ${serverId} is ${server.status}; the restore can't be cancelled now`);
      }
      const ok = await store.transition(serverId, {
        from: [server.status],
        to: server.status,
        remove: ['restoreKey', 'restoreSource', 'restoreRequestedAt'],
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

/** The request, checked against its schema (`@hearth/shared/api`), or a 400 saying what's wrong. */
function parse<T>(schema: z.ZodType<T>, request: unknown): T {
  const result = check(schema, request);
  if (!result.ok) throw new OperationError(400, result.message);
  return result.value;
}
