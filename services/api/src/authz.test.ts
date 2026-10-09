import { describe, expect, it } from 'vitest';
import type { ServerAccessRecord, ServerAction, ServerRecord, ServerRole } from '@hearth/shared';
import { AccessDenied, decide, requireAdmin, serverAuthorizer, shapeServer, type Actor } from './authz.js';

// The permission table, spelled out again on purpose: changing who may do what must change this
// test too, so it can't happen by accident.
const EXPECTED: Record<ServerAction, { owner: boolean; member: boolean }> = {
  view: { owner: true, member: true },
  start: { owner: true, member: true },
  stop: { owner: true, member: true },
  settings: { owner: true, member: false },
  version: { owner: true, member: false },
  backups: { owner: true, member: false },
  restore: { owner: true, member: false },
  destroy: { owner: true, member: false },
  invite: { owner: true, member: false },
  members: { owner: true, member: true },
  removeMember: { owner: true, member: false },
};
const ACTIONS = Object.keys(EXPECTED) as ServerAction[];

const user: Actor = { kind: 'user', userId: 'u1' };
const admin: Actor = { kind: 'admin', id: 'arn:admin' };
const agent: Actor = { kind: 'agent', serverId: 's1', instanceId: 'i-1' };

describe('decide', () => {
  for (const action of ACTIONS) {
    for (const role of ['owner', 'member'] as ServerRole[]) {
      const allowed = EXPECTED[action][role];
      it(`${role}: ${action} is ${allowed ? 'allowed' : 'forbidden'}`, () => {
        expect(decide(user, action, 's1', role)).toEqual(
          allowed ? { allow: true, relation: role } : { allow: false, reason: 'forbidden' },
        );
      });
    }
  }

  it('a user without access finds no server, whatever the action', () => {
    for (const action of ACTIONS) {
      expect(decide(user, action, 's1', undefined)).toEqual({ allow: false, reason: 'not-found' });
    }
  });

  it('an admin may do everything to every server', () => {
    for (const action of ACTIONS) {
      expect(decide(admin, action, 'any', undefined)).toEqual({ allow: true, relation: 'admin' });
    }
  });

  it('an agent may only stop its own server', () => {
    expect(decide(agent, 'stop', 's1', undefined).allow).toBe(true);
    expect(decide(agent, 'stop', 's2', undefined)).toEqual({ allow: false, reason: 'not-found' });
    for (const action of ACTIONS.filter((a) => a !== 'stop')) {
      expect(decide(agent, action, 's1', undefined)).toEqual({ allow: false, reason: 'not-found' });
    }
  });
});

describe('serverAuthorizer', () => {
  function fakeAccess(rows: Partial<ServerAccessRecord>[]) {
    const reads: string[] = [];
    return {
      reads,
      access: {
        getAccess: async (userId: string, serverId: string) => {
          reads.push(`${userId} ${serverId}`);
          return rows.find((r) => r.userId === userId && r.serverId === serverId) as ServerAccessRecord | undefined;
        },
      },
    };
  }

  it("reads a user's access and returns their relation", async () => {
    const { access, reads } = fakeAccess([{ userId: 'u1', serverId: 's1', role: 'member' }]);
    expect(await serverAuthorizer(access)(user, 'start', 's1')).toBe('member');
    expect(reads).toEqual(['u1 s1']);
  });

  it('answers 404 without access, in the same words as for a server that does not exist', async () => {
    const { access } = fakeAccess([]);
    await expect(serverAuthorizer(access)(user, 'view', 's9')).rejects.toEqual(new AccessDenied(404, 'No server s9'));
  });

  it('answers 403 for a role without the permission, naming what was refused', async () => {
    const { access } = fakeAccess([{ userId: 'u1', serverId: 's1', role: 'member' }]);
    await expect(serverAuthorizer(access)(user, 'destroy', 's1')).rejects.toEqual(
      new AccessDenied(403, "As a member, you can't destroy server s1"),
    );
  });

  it('never reads access for admins or agents', async () => {
    const { access, reads } = fakeAccess([]);
    expect(await serverAuthorizer(access)(admin, 'destroy', 's1')).toBe('admin');
    await serverAuthorizer(access)(agent, 'stop', 's1');
    expect(reads).toEqual([]);
    // Routes without user callers have no access store at all.
    expect(await serverAuthorizer()(admin, 'view', 's1')).toBe('admin');
  });

  it('refuses a user on a route that has no access store, rather than guessing', async () => {
    await expect(serverAuthorizer()(user, 'view', 's1')).rejects.toThrow('No access store');
  });
});

describe('requireAdmin', () => {
  it('lets admins through and refuses everyone else with 403', () => {
    expect(() => requireAdmin(admin)).not.toThrow();
    expect(() => requireAdmin(user)).toThrow(new AccessDenied(403, 'Only Hearth admins can do that'));
    expect(() => requireAdmin(agent)).toThrow(AccessDenied);
  });
});

describe('shapeServer', () => {
  const record: ServerRecord = {
    serverId: 's1',
    ownerId: 'u1',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'RUNNING',
    version: '26.3',
    autoUpdate: false,
    agentChannel: 'canary',
    instanceId: 'i-1',
    volumeId: 'vol-1',
    agentState: 'ready',
    agentVersion: '2026.10.06-de42566',
    publicIp: '35.1.2.3',
    lastOperationId: 'op1',
    lastBackupKey: 'servers/s1/20261005T120000Z.tar.gz',
    lastBackupAt: '2026-10-05T12:00:10.000Z',
    restoreKey: 'servers/s1/20261004T120000Z.tar.gz',
    createdAt: '2026-10-01T12:00:00.000Z',
  };

  it('gives admins the whole record', () => {
    expect(shapeServer(record, 'admin')).toBe(record);
  });

  it('gives owners and members what the UI shows, and nothing internal', () => {
    expect(shapeServer(record, 'member')).toEqual({
      serverId: 's1',
      role: 'member',
      game: 'minecraft-java',
      region: 'us-west-2',
      version: '26.3',
      status: 'RUNNING',
      address: '35.1.2.3',
      gameState: 'ready',
      idleStopMinutes: 30,
      lastBackupAt: '2026-10-05T12:00:10.000Z',
      restorePending: true,
      createdAt: '2026-10-01T12:00:00.000Z',
    });
  });

  it('shows no address or game state once the server is stopped', () => {
    const view = shapeServer({ ...record, status: 'STOPPED', idleStopMinutes: 0 }, 'owner');
    expect(view).not.toHaveProperty('address');
    expect(view).not.toHaveProperty('gameState');
    expect(view).toMatchObject({ role: 'owner', idleStopMinutes: 0 });
    // Whether the last stop saved the game (the agent's message stays internal).
    const unclean = shapeServer({ ...record, status: 'STOPPED', lastStopClean: false, agentMessage: 'timeout' }, 'owner');
    expect(unclean).toMatchObject({ lastStopClean: false });
    expect(unclean).not.toHaveProperty('agentMessage');
  });
});
