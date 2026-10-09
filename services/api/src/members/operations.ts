import type { AccessStore, UsersStore } from '@hearth/core';
import type { Member, ServerAccessRecord, UserRecord } from '@hearth/shared';
import { actorId, serverAuthorizer, type Actor } from '../authz.js';
import { OperationError } from '../servers/operations.js';

export interface MemberOperationDeps {
  access: Pick<AccessStore, 'getAccess' | 'listForServer' | 'removeMember'>;
  users: Pick<UsersStore, 'getUser'>;
}

/** Who has access to a server: owners and members see it, owners remove members, members leave. */
export function memberOperations({ access, users }: MemberOperationDeps) {
  const authorize = serverAuthorizer(access);

  /** Removes a member's access; refuses the owner's (only destroying the server ends that). */
  async function remove(userId: string, serverId: string, refusals: { owner: string; notMember: string }): Promise<void> {
    const row = await access.getAccess(userId, serverId);
    if (row?.role === 'owner') throw new OperationError(409, refusals.owner);
    if (!row || !(await access.removeMember(userId, serverId))) throw new OperationError(404, refusals.notMember);
  }

  return {
    /** Owners and members: everyone with access, the owner first, then members by when they joined. */
    async listMembers(actor: Actor, serverId: string): Promise<Member[]> {
      await authorize(actor, 'members', serverId);
      const rows = (await access.listForServer(serverId)).sort(
        (a, b) => Number(b.role === 'owner') - Number(a.role === 'owner') || a.addedAt.localeCompare(b.addedAt),
      );
      return Promise.all(rows.map(async (row) => view(row, await users.getUser(row.userId))));
    },

    /** Owners: takes a member's access away. */
    async removeMember(actor: Actor, serverId: string, userId: string): Promise<void> {
      await authorize(actor, 'removeMember', serverId);
      await remove(userId, serverId, {
        owner: `${userId} owns server ${serverId}; an owner can't be removed`,
        notMember: `${userId} isn't a member of server ${serverId}`,
      });
    },

    /** Members: gives up their own access. Its owner can't leave (they destroy it instead). */
    async leaveServer(actor: Actor, serverId: string): Promise<void> {
      if (actor.kind === 'agent') throw new OperationError(403, 'Agents cannot leave servers');
      await authorize(actor, 'view', serverId);
      const userId = actorId(actor);
      // An admin reaches every server without being a member of it.
      await remove(userId, serverId, {
        owner: `You own server ${serverId}: an owner can't leave it (destroy it instead)`,
        notMember: `You aren't a member of server ${serverId}`,
      });
    },
  };
}

/** A member as others see them: a name and picture, never their email. */
function view(row: ServerAccessRecord, user: UserRecord | undefined): Member {
  const name = user?.displayName ?? user?.name ?? user?.username;
  return {
    userId: row.userId,
    role: row.role,
    ...(name ? { name } : {}),
    ...(user?.picture ? { picture: user.picture } : {}),
    addedAt: row.addedAt,
    addedBy: row.addedBy,
  };
}
