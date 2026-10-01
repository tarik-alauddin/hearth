import { InvalidCursor, newId as defaultNewId, type ServersStore } from '@hearth/core';
import {
  GAMES,
  type CreateServerRequest,
  type GameId,
  type ListServersResponse,
  type ServerOperationResult,
  type ServerRecord,
  type ServerStatus,
} from '@hearth/shared';

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
  store: Pick<ServersStore, 'getServer' | 'listServers' | 'createServer' | 'transition'>;
  workflows: Workflows;
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
      const { game, version, region = homeRegion } = validateCreate(request);
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
  };
}

function validateCreate(request: unknown): CreateServerRequest {
  if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
  const { game, version, region } = request as Record<string, unknown>;
  if (!(GAMES as readonly unknown[]).includes(game)) throw new OperationError(400, `Unknown game; one of ${GAMES.join(', ')}`);
  if (typeof version !== 'string' || !VERSION.test(version)) throw new OperationError(400, 'Invalid version');
  if (region !== undefined && typeof region !== 'string') throw new OperationError(400, 'Invalid region');
  return { game: game as GameId, version, ...(region ? { region } : {}) };
}
