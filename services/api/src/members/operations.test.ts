import { describe, expect, it } from 'vitest';
import type { ServerAccessRecord, UserRecord } from '@hearth/shared';
import type { Actor } from '../authz.js';
import { memberOperations } from './operations.js';

const owner: Actor = { kind: 'user', userId: 'owner' };
const friend: Actor = { kind: 'user', userId: 'friend' };
const stranger: Actor = { kind: 'user', userId: 'stranger' };
const admin: Actor = { kind: 'admin', id: 'arn:admin' };

function user(userId: string, profile: Partial<UserRecord>): UserRecord {
  return { userId, approved: false, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then', ...profile };
}

/** In-memory ServerAccess and Users, with the store's rule (removeMember: members only). */
function setup() {
  const rows: ServerAccessRecord[] = [
    { userId: 'friend', serverId: 's1', role: 'member', addedAt: '2026-10-02T00:00:00Z', addedBy: 'owner', inviteCode: 'C' },
    { userId: 'owner', serverId: 's1', role: 'owner', addedAt: '2026-10-03T00:00:00Z', addedBy: 'owner' },
    { userId: 'other', serverId: 's1', role: 'member', addedAt: '2026-10-01T00:00:00Z', addedBy: 'owner' },
  ];
  const users = [
    user('owner', { name: 'Owner Name', email: 'owner@example.com', picture: 'https://pic/owner' }),
    user('friend', { username: 'friend_1', displayName: 'Friend', email: 'friend@example.com' }),
  ];
  const ops = memberOperations({
    access: {
      getAccess: async (userId, serverId) => rows.find((r) => r.userId === userId && r.serverId === serverId),
      listForServer: async (serverId) => rows.filter((r) => r.serverId === serverId),
      removeMember: async (userId, serverId) => {
        const i = rows.findIndex((r) => r.userId === userId && r.serverId === serverId && r.role === 'member');
        return i >= 0 && rows.splice(i, 1).length === 1;
      },
    },
    users: { getUser: async (userId) => users.find((u) => u.userId === userId) },
  });
  return { ops, rows };
}

describe('member operations', () => {
  it('lists the owner first, then members by when they joined, with names and no emails', async () => {
    const { ops } = setup();
    const members = await ops.listMembers(friend, 's1');
    expect(members.map((m) => [m.userId, m.role, m.name])).toEqual([
      ['owner', 'owner', 'Owner Name'],
      ['other', 'member', undefined], // never signed in: no profile
      ['friend', 'member', 'Friend'], // Discord's display name over the username
    ]);
    expect(members[0]?.picture).toBe('https://pic/owner');
    expect(JSON.stringify(members)).not.toContain('@example.com');
    expect(await ops.listMembers(admin, 's1')).toHaveLength(3);
    await expect(ops.listMembers(stranger, 's1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets the owner (and admins) remove a member, never the owner', async () => {
    const { ops, rows } = setup();
    await ops.removeMember(owner, 's1', 'friend');
    expect(rows.map((r) => r.userId)).toEqual(['owner', 'other']);
    await expect(ops.removeMember(owner, 's1', 'friend')).rejects.toMatchObject({ statusCode: 404 });
    await expect(ops.removeMember(owner, 's1', 'owner')).rejects.toMatchObject({ statusCode: 409 });
    await ops.removeMember(admin, 's1', 'other');
    expect(rows.map((r) => r.userId)).toEqual(['owner']);
  });

  it("refuses members removing others (403) and strangers (404), changing nothing", async () => {
    const { ops, rows } = setup();
    await expect(ops.removeMember(friend, 's1', 'other')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ops.removeMember(stranger, 's1', 'friend')).rejects.toMatchObject({ statusCode: 404 });
    expect(rows).toHaveLength(3);
  });

  it('lets a member leave; the owner cannot, and anyone else has nothing to leave', async () => {
    const { ops, rows } = setup();
    await ops.leaveServer(friend, 's1');
    expect(rows.some((r) => r.userId === 'friend')).toBe(false);
    await expect(ops.leaveServer(friend, 's1')).rejects.toMatchObject({ statusCode: 404 }); // no access now
    await expect(ops.leaveServer(owner, 's1')).rejects.toMatchObject({ statusCode: 409 });
    await expect(ops.leaveServer(admin, 's1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(ops.leaveServer({ kind: 'agent', serverId: 's1', instanceId: 'i-1' }, 's1')).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(rows.some((r) => r.userId === 'owner')).toBe(true);
  });
});
