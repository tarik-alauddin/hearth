import type { AccessStore } from '@hearth/core';
import {
  DEFAULT_IDLE_STOP_MINUTES,
  roleCan,
  type ServerAction,
  type ServerRecord,
  type ServerRole,
  type ServerView,
} from '@hearth/shared';

/**
 * Who is asking. Routes say who, never what they may do: every operation passes the actor to
 * `authorize` (one server) or `requireAdmin` (the whole platform).
 */
export type Actor =
  /** A Hearth admin: a signed-in user in the Cognito `admin` group (`id` is their sub). */
  | { kind: 'admin'; id: string }
  /** A signed-in user (their Cognito `sub`). */
  | { kind: 'user'; userId: string }
  /** A game instance's agent, which only ever acts on its own server. */
  | { kind: 'agent'; serverId: string; instanceId: string };

/** What the caller is to a server they may act on. */
export type Relation = ServerRole | 'admin';

/** The outcome of a permission check; `authorize` turns denials into 404 and 403. */
export type Decision = { allow: true; relation: Relation } | { allow: false; reason: 'not-found' | 'forbidden' };

/**
 * The rule, without I/O: `role` is the user's access to the server (undefined: none). Admins may
 * do anything; an agent may only stop its own server; a user, what SERVER_PERMISSIONS lets their
 * role. No access reads as not found, so server IDs don't leak; access without the right role is
 * forbidden.
 */
export function decide(actor: Actor, action: ServerAction, serverId: string, role: ServerRole | undefined): Decision {
  switch (actor.kind) {
    case 'admin':
      return { allow: true, relation: 'admin' };
    case 'agent':
      return actor.serverId === serverId && action === 'stop'
        ? { allow: true, relation: 'owner' }
        : { allow: false, reason: 'not-found' };
    case 'user':
      if (!role) return { allow: false, reason: 'not-found' };
      return roleCan(role, action) ? { allow: true, relation: role } : { allow: false, reason: 'forbidden' };
  }
}

/** A denied request, with the HTTP status the routes answer with. */
export class AccessDenied extends Error {
  constructor(
    readonly statusCode: 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

const VERBS: Record<ServerAction, string> = {
  view: 'see',
  start: 'start',
  stop: 'stop',
  settings: 'change the settings of',
  version: 'change the version of',
  backups: 'see the backups of',
  restore: 'restore',
  destroy: 'destroy',
  invite: 'invite people to',
  members: 'see the members of',
  removeMember: 'remove members from',
};

/**
 * Checks the actor may do `action` to `serverId`, reading the user's access when it matters.
 * Throws AccessDenied: 404 (the same message as for a server that doesn't exist) or 403.
 * Returns the caller's relation, for shaping the response.
 */
export function serverAuthorizer(access?: Pick<AccessStore, 'getAccess'>) {
  return async function authorize(actor: Actor, action: ServerAction, serverId: string): Promise<Relation> {
    let role: ServerRole | undefined;
    if (actor.kind === 'user') {
      // Only the routes for signed-in users (/v1) have the access table; they always pass it.
      if (!access) throw new Error('No access store: this route takes no user callers');
      role = (await access.getAccess(actor.userId, serverId))?.role;
    }
    const decision = decide(actor, action, serverId, role);
    if (decision.allow) return decision.relation;
    if (decision.reason === 'forbidden') {
      throw new AccessDenied(403, `As a ${role ?? 'non-member'}, you can't ${VERBS[action]} server ${serverId}`);
    }
    throw new AccessDenied(404, `No server ${serverId}`);
  };
}

/** Platform-wide actions (every server, users, agent channels, the fleet check): admins only. */
export function requireAdmin(actor: Actor): void {
  if (actor.kind !== 'admin') throw new AccessDenied(403, 'Only Hearth admins can do that');
}

/** The id that owns what an actor creates: a user's sub, or an admin's identity. */
export function actorId(actor: Actor): string {
  switch (actor.kind) {
    case 'admin':
      return actor.id;
    case 'user':
      return actor.userId;
    case 'agent':
      return actor.instanceId;
  }
}

/**
 * The UI's view of a server, for any caller (`/v1` answers with it for admins too, with the role
 * `admin`): what the UI shows, without instance IDs, storage keys or agent internals.
 */
export function toServerView(server: ServerRecord, relation: Relation): ServerView {
  return {
    serverId: server.serverId,
    role: relation,
    game: server.game,
    region: server.region,
    version: server.version,
    status: server.status,
    ...(server.statusMessage !== undefined ? { statusMessage: server.statusMessage } : {}),
    ...(server.status === 'RUNNING' && server.publicIp ? { address: server.publicIp } : {}),
    ...(server.status === 'RUNNING' || server.status === 'STARTING' ? optional('gameState', server.agentState) : {}),
    idleStopMinutes: server.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES,
    ...optional('stopReason', server.stopReason),
    ...optional('lastStartedAt', server.lastStartedAt),
    ...optional('lastStoppedAt', server.lastStoppedAt),
    ...optional('lastStopClean', server.lastStopClean),
    ...optional('lastBackupAt', server.lastBackupAt),
    restorePending: server.restoreKey !== undefined,
    ...optional('createdAt', server.createdAt),
    ...optional('destroyedAt', server.destroyedAt),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
