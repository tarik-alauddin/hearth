import { describe, expect, it } from 'vitest';
import type { InviteRecord, ServerAccessRecord, ServerRecord } from '@hearth/shared';
import type { Actor } from '../authz.js';
import { inviteOperations } from './operations.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const owner: Actor = { kind: 'user', userId: 'owner' };
const friend: Actor = { kind: 'user', userId: 'friend' };
const stranger: Actor = { kind: 'user', userId: 'stranger' };

function server(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    serverId: 's1',
    ownerId: 'owner',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'STOPPED',
    version: '26.3',
    autoUpdate: false,
    ...overrides,
  };
}

/** In-memory Servers, ServerAccess and Invites, with the stores' rules (grant: only without access). */
function setup(servers: ServerRecord[] = [server()]) {
  const rows: ServerAccessRecord[] = [{ userId: 'owner', serverId: 's1', role: 'owner', addedAt: 'then', addedBy: 'owner' }];
  const invites = new Map<string, InviteRecord>();
  let now = NOW;
  const ops = inviteOperations({
    servers: { getServer: async (id) => servers.find((s) => s.serverId === id) },
    access: {
      getAccess: async (userId, serverId) => rows.find((r) => r.userId === userId && r.serverId === serverId),
      grant: async (row) => {
        if (rows.some((r) => r.userId === row.userId && r.serverId === row.serverId)) return false;
        rows.push(row);
        return true;
      },
    },
    invites: {
      create: async (invite) => void invites.set(invite.code, invite),
      getActive: async (code, at) => {
        const invite = invites.get(code);
        return invite && invite.expiresAt > at.toISOString() ? invite : undefined;
      },
      listActiveForServer: async (serverId, at) =>
        [...invites.values()].filter((i) => i.serverId === serverId && i.expiresAt > at.toISOString()).reverse(),
      revoke: async (code, serverId) => invites.get(code)?.serverId === serverId && invites.delete(code),
    },
    now: () => now,
  });
  return { ops, rows, invites, later: (days: number) => (now = new Date(NOW.getTime() + days * 86_400_000)) };
}

describe('invites', () => {
  it('lets the owner create a 7-day invite, shown in groups of four', async () => {
    const { ops, invites } = setup();
    const invite = await ops.createInvite(owner, 's1');
    expect(invite).toMatchObject({ createdBy: 'owner', createdAt: '2026-10-09T12:00:00.000Z', expiresAt: '2026-10-16T12:00:00.000Z' });
    expect(invite.code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(invites.size).toBe(1);
  });

  it('makes whoever accepts a member, however they typed the code', async () => {
    const { ops, rows } = setup();
    const { code } = await ops.createInvite(owner, 's1');
    const joined = await ops.acceptInvite(friend, ` ${code.toLowerCase().replace(/-/g, ' ')} `);
    expect(joined).toMatchObject({ relation: 'member', server: { serverId: 's1' } });
    expect(rows).toContainEqual(
      expect.objectContaining({ userId: 'friend', serverId: 's1', role: 'member', addedBy: 'owner', inviteCode: code.replace(/-/g, '') }),
    );
  });

  it('changes nothing for someone with access already: the owner stays owner, accepting twice is one member', async () => {
    const { ops, rows } = setup();
    const { code } = await ops.createInvite(owner, 's1');
    expect((await ops.acceptInvite(owner, code)).relation).toBe('owner');
    await ops.acceptInvite(friend, code);
    await ops.acceptInvite(friend, code);
    expect(rows.filter((r) => r.serverId === 's1')).toHaveLength(2);
  });

  it('answers 404 alike for a wrong, malformed, expired or revoked code', async () => {
    const { ops, later } = setup();
    const { code } = await ops.createInvite(owner, 's1');
    const revoked = (await ops.createInvite(owner, 's1')).code;
    await ops.revokeInvite(owner, 's1', revoked);

    for (const attempt of ['0000-0000-0000-0000-0000', 'nonsense', revoked]) {
      await expect(ops.acceptInvite(friend, attempt)).rejects.toMatchObject({ statusCode: 404 });
    }
    later(7);
    await expect(ops.acceptInvite(friend, code)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses to join a destroyed server, and won't invite to one", async () => {
    const destroyed = setup([server({ status: 'DESTROYED' })]);
    await expect(destroyed.ops.createInvite(owner, 's1')).rejects.toMatchObject({ statusCode: 409 });

    const { ops } = setup();
    const { code } = await ops.createInvite(owner, 's1');
    const gone = setup([server({ status: 'DESTROYED' })]);
    gone.invites.set(code.replace(/-/g, ''), { code: code.replace(/-/g, ''), serverId: 's1', createdBy: 'owner', createdAt: 'x', expiresAt: '2099-01-01', expiresAtEpoch: 0 });
    await expect(gone.ops.acceptInvite(friend, code)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists and revokes for owners only: members get 403, strangers 404', async () => {
    const { ops } = setup();
    const { code } = await ops.createInvite(owner, 's1');
    await ops.acceptInvite(friend, code);

    expect((await ops.listInvites(owner, 's1')).map((i) => i.code)).toEqual([code]);
    await expect(ops.createInvite(friend, 's1')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ops.listInvites(friend, 's1')).rejects.toMatchObject({ statusCode: 403 });
    await expect(ops.revokeInvite(friend, 's1', code)).rejects.toMatchObject({ statusCode: 403 });
    await expect(ops.listInvites(stranger, 's1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it("revokes only an invite of the given server, and a revoked code can't be revoked again", async () => {
    const { ops } = setup([server(), server({ serverId: 's2' })]);
    const { code } = await ops.createInvite(owner, 's1');
    const admin: Actor = { kind: 'admin', id: 'root' };
    await expect(ops.revokeInvite(admin, 's2', code)).rejects.toMatchObject({ statusCode: 404 });
    await ops.revokeInvite(owner, 's1', code);
    await expect(ops.revokeInvite(owner, 's1', code)).rejects.toMatchObject({ statusCode: 404 });
  });
});
