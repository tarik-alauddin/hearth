import { formatInviteCode, newInvite, parseInviteCode, type AccessStore, type InvitesStore, type ServersStore } from '@hearth/core';
import type { Invite, InviteRecord, ServerRecord } from '@hearth/shared';
import { actorId, serverAuthorizer, type Actor, type Relation } from '../authz.js';
import { OperationError } from '../servers/operations.js';

export interface InviteOperationDeps {
  servers: Pick<ServersStore, 'getServer'>;
  access: Pick<AccessStore, 'getAccess' | 'grant'>;
  invites: InvitesStore;
  now?: () => Date;
}

/**
 * Invites: owners create codes for a server; any signed-in user accepts one to become a member.
 * Membership is the access, not the code: revoking a code stops new members, not existing ones.
 */
export function inviteOperations({ servers, access, invites, now = () => new Date() }: InviteOperationDeps) {
  const authorize = serverAuthorizer(access);

  async function liveServer(serverId: string): Promise<ServerRecord> {
    const server = await servers.getServer(serverId);
    if (!server) throw new OperationError(404, `No server ${serverId}`);
    if (server.status === 'DESTROYED' || server.status === 'DESTROYING') {
      throw new OperationError(409, `Server ${serverId} is ${server.status}; nobody can join it`);
    }
    return server;
  }

  return {
    /** Owners: a new 7-day invite to the server. */
    async createInvite(actor: Actor, serverId: string): Promise<Invite> {
      await authorize(actor, 'invite', serverId);
      await liveServer(serverId);
      const invite = newInvite(serverId, actorId(actor), now());
      await invites.create(invite);
      return view(invite);
    },

    /** Owners: the server's unexpired invites, newest first. */
    async listInvites(actor: Actor, serverId: string): Promise<Invite[]> {
      await authorize(actor, 'invite', serverId);
      return (await invites.listActiveForServer(serverId, now())).map(view);
    },

    /** Owners: revokes an invite to this server (only this server's: the code alone isn't enough). */
    async revokeInvite(actor: Actor, serverId: string, code: string): Promise<void> {
      await authorize(actor, 'invite', serverId);
      const parsed = parseInviteCode(code);
      if (!parsed || !(await invites.revoke(parsed, serverId))) {
        throw new OperationError(404, `No invite ${code} to server ${serverId}`);
      }
    },

    /**
     * Any signed-in user: accepting makes them a member of the invite's server. Someone with
     * access already (its owner, a member) keeps their role. A wrong, expired or revoked code, or
     * one whose server is gone, is 404 alike: a code tells nothing about whether it ever existed.
     */
    async acceptInvite(actor: Actor, code: string): Promise<{ server: ServerRecord; relation: Relation }> {
      if (actor.kind === 'agent') throw new OperationError(403, 'Agents cannot accept invites');
      const notFound = new OperationError(404, 'No such invite: it may have expired or been revoked');
      const parsed = parseInviteCode(code);
      const invite = parsed ? await invites.getActive(parsed, now()) : undefined;
      if (!invite) throw notFound;
      const server = await servers.getServer(invite.serverId);
      if (!server || server.status === 'DESTROYED' || server.status === 'DESTROYING') throw notFound;

      const userId = actorId(actor);
      await access.grant({
        userId,
        serverId: server.serverId,
        role: 'member',
        addedAt: now().toISOString(),
        addedBy: invite.createdBy,
        inviteCode: invite.code,
      });
      // Granted now, or they had access already (grant changes nothing then): their role either way.
      const role = (await access.getAccess(userId, server.serverId))?.role;
      return { server, relation: actor.kind === 'admin' && !role ? 'admin' : (role ?? 'member') };
    },
  };
}

function view(invite: InviteRecord): Invite {
  return {
    code: formatInviteCode(invite.code),
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
  };
}
