import type { UsersStore } from '@hearth/core';
import type { UserRecord } from '@hearth/shared';
import { SetApprovalRequestSchema } from '@hearth/shared/api';
import { actorId, requireAdmin, type Actor } from '../authz.js';
import { OperationError } from '../servers/operations.js';
import { check } from '../validation.js';

export interface UserOperationDeps {
  users: Pick<UsersStore, 'getUser' | 'setApproved'>;
  now?: () => Date;
}

/** Operations on users (not servers). Like the server operations, each takes the actor first. */
export function userOperations({ users, now = () => new Date() }: UserOperationDeps) {
  return {
    /**
     * Admins: approves a user (they may then create servers), or takes approval back (servers
     * they already own keep running). The user must have signed in once, which creates them.
     * Never your own: admins need no approval, so changing it would only mislead.
     */
    async setApproval(actor: Actor, userId: string, request: unknown): Promise<UserRecord> {
      requireAdmin(actor);
      const parsed = check(SetApprovalRequestSchema, request);
      if (!parsed.ok) throw new OperationError(400, parsed.message);
      if (actorId(actor) === userId) {
        throw new OperationError(409, "You can't change your own approval (admins need none to create servers)");
      }
      if (!(await users.setApproved(userId, parsed.value.approved, now()))) {
        throw new OperationError(404, `No user ${userId}: they sign in once first`);
      }
      const user = await users.getUser(userId);
      if (!user) throw new OperationError(404, `No user ${userId}`);
      return user;
    },
  };
}
