import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FleetReport, ServerRecord, ServerView, UploadStatus } from '@hearth/shared';
import { ApiError, type Api } from './client.js';
import { CommandError, commands, type CommandDeps } from './commands.js';

function view(overrides: Partial<ServerView>): ServerView {
  return {
    serverId: 's1',
    role: 'owner',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'STARTING',
    version: '1.21.4',
    idleStopMinutes: 30,
    restorePending: false,
    ...overrides,
  };
}

function record(overrides: Partial<ServerRecord>): ServerRecord {
  return { serverId: 's1', ownerId: 'o', game: 'minecraft-java', region: 'us-west-2', status: 'STOPPED', version: '1.21.4', autoUpdate: false, ...overrides };
}

/** An Api that records each call as "METHOD path body" and answers with `answer`. */
function recorder(calls: string[], answer: (method: string, path: string, body: unknown) => unknown): Api {
  const call = (method: string) => async (path: string, body?: unknown) => {
    const shown = method === 'GET' ? (body && Object.keys(body).length ? ` ${JSON.stringify(body)}` : '') : body === undefined ? '' : ` ${JSON.stringify(body)}`;
    calls.push(`${method} ${path}${shown}`);
    return answer(method, path, body);
  };
  return { get: call('GET'), post: call('POST'), patch: call('PATCH'), delete: call('DELETE') } as Api;
}

/**
 * The /v1 API: GET /v1/servers/s1 walks through `states` (the last repeats); actions answer as
 * the API does (a workflow result, or the server as the caller sees it). With `admin`, the caller
 * is an admin: the admin routes serve its `pages` of every server and its `record`; without, 403.
 */
function fakeApis(
  states: Partial<ServerView>[] = [],
  opts: { admin?: { pages?: ServerRecord[][]; record?: ServerRecord }; mine?: ServerView[]; backups?: unknown[] } = {},
) {
  const calls: string[] = [];
  let i = 0;
  const pages = [...(opts.admin?.pages ?? [])];
  const api = recorder(calls, (method, path, body) => {
    if (path.startsWith('/v1/admin/servers')) {
      if (!opts.admin) throw new ApiError(403, 'Only Hearth admins can do that');
      if (path === '/v1/admin/servers') return { servers: pages.shift() ?? [], ...(pages.length ? { cursor: `c${pages.length}` } : {}) };
      return opts.admin.record;
    }
    if (method === 'GET' && path === '/v1/servers') return { servers: opts.mine ?? [] };
    if (path.endsWith('/backups')) return { backups: opts.backups ?? [] };
    if (path.startsWith('/v1/admin/users/')) {
      return { userId: 'u-1', approved: (body as { approved: boolean }).approved, serverLimit: 3, createdAt: 'then', lastSeenAt: 'then', name: 'Friend' };
    }
    if (method === 'GET') return view(states[Math.min(i++, states.length - 1)] ?? {});
    if (method === 'PATCH') return view(body as Partial<ServerView>);
    if (path === '/v1/servers' || /\/(start|stop|destroy)$/.test(path)) {
      return { serverId: 's1', status: path.endsWith('/stop') ? 'STOPPING' : path.endsWith('/destroy') ? 'DESTROYING' : 'STARTING' };
    }
    return view({ version: (body as { version?: string } | undefined)?.version ?? '1.21.4' });
  });
  return { api, calls };
}

function run(apis: { api: Api }, deps: Partial<CommandDeps> = {}) {
  const out: string[] = [];
  const cmd = commands({ ...apis, print: (l) => out.push(l), sleep: async () => {}, pollMs: 1, timeoutMs: 100, ...deps });
  return { out, cmd };
}

describe('commands', () => {
  it('create goes through /v1, waits until running and prints the join address', async () => {
    const apis = fakeApis([
      { status: 'PROVISIONING' },
      { status: 'STARTING', gameState: 'starting' },
      { status: 'RUNNING', gameState: 'ready', address: '35.1.2.3' }, // the address comes with RUNNING
    ]);
    const { out, cmd } = run(apis);
    await cmd.create({ game: 'minecraft-java', version: '1.21.4', wait: true });

    expect(apis.calls[0]).toBe('POST /v1/servers {"game":"minecraft-java","version":"1.21.4"}');
    expect(apis.calls.slice(1)).toEqual(Array(3).fill('GET /v1/servers/s1'));
    expect(out).toEqual([
      'Creating s1 (minecraft-java 1.21.4). The first start takes a few minutes.',
      '  PROVISIONING',
      '  STARTING · game starting',
      '  RUNNING · game ready',
      'Ready. Join at 35.1.2.3:25565   (server s1)',
    ]);
  });

  it('fails with the reason when the server fails', async () => {
    const apis = fakeApis([{ status: 'FAILED', statusMessage: 'AgentError: image pull failed' }]);
    await expect(run(apis).cmd.start('s1', true)).rejects.toThrow('Failed: AgentError: image pull failed');
  });

  it('gives up after the timeout', async () => {
    await expect(run(fakeApis([{ status: 'STARTING' }])).cmd.start('s1', true)).rejects.toBeInstanceOf(CommandError);
  });

  it('starts and stops through /v1, and does not wait with --no-wait', async () => {
    const apis = fakeApis();
    const { cmd } = run(apis);
    await cmd.start('s1', false);
    await cmd.stop('s1', false);
    expect(apis.calls).toEqual(['POST /v1/servers/s1/start', 'POST /v1/servers/s1/stop']);
  });

  it('stop reports whether the game was saved', async () => {
    const unclean = run(fakeApis([{ status: 'STOPPING' }, { status: 'STOPPED', lastStopClean: false }]));
    await unclean.cmd.stop('s1', true);
    expect(unclean.out.at(-1)).toMatch(/did not report a clean stop/);
    const clean = run(fakeApis([{ status: 'STOPPED', lastStopClean: true }]));
    await clean.cmd.stop('s1', true);
    expect(clean.out.at(-1)).toBe('Stopped. Game saved.');
  });

  it('lists backups by name as a table, or says there are none', async () => {
    const backups = [
      { id: '20261005T120000Z.tar.gz', takenAt: '2026-10-05T12:00:10.000Z', bytes: 3 * 2 ** 20 },
      { id: '20261004T120000Z.tar.gz', takenAt: '2026-10-04T12:00:10.000Z', bytes: 2 ** 20 },
    ];
    const apis = fakeApis([], { backups });
    const { out, cmd } = run(apis);
    await cmd.backups('s1');
    expect(apis.calls).toEqual(['GET /v1/servers/s1/backups']);
    expect(out).toEqual([
      'TAKEN                     SIZE     BACKUP',
      '2026-10-05T12:00:10.000Z  3.0 MiB  20261005T120000Z.tar.gz',
      '2026-10-04T12:00:10.000Z  1.0 MiB  20261004T120000Z.tar.gz',
    ]);

    const empty = run(fakeApis());
    await empty.cmd.backups('s1');
    expect(empty.out).toEqual(['No backups yet. One is taken each time the server stops.']);
  });

  it('requests a restore with an optional backup and force, and cancels one', async () => {
    const apis = fakeApis();
    const { out, cmd } = run(apis);
    await cmd.restore('s1', undefined, false);
    await cmd.restore('s1', '20261004T120000Z.tar.gz', true);
    await cmd.cancelRestore('s1');
    expect(apis.calls).toEqual([
      'POST /v1/servers/s1/restore {}',
      'POST /v1/servers/s1/restore {"key":"20261004T120000Z.tar.gz","force":true}',
      'DELETE /v1/servers/s1/restore',
    ]);
    expect(out[0]).toBe('s1 will restore its newest backup on its next start, replacing the current game data.');
    expect(out[2]).toBe('s1 will restore 20261004T120000Z.tar.gz on its next start, replacing the current game data.');
    expect(out.at(-1)).toBe('No restore pending for s1.');
  });

  it('sets the version', async () => {
    const apis = fakeApis();
    const { out, cmd } = run(apis);
    await cmd.setVersion('s1', '26.3');
    expect(apis.calls).toEqual(['POST /v1/servers/s1/version {"version":"26.3"}']);
    expect(out).toEqual(['s1 runs minecraft-java 26.3 from its next start.']);
  });

  it('sets the idle limit in minutes, or off', async () => {
    const apis = fakeApis();
    const { out, cmd } = run(apis);
    await cmd.setIdle('s1', '45');
    await cmd.setIdle('s1', 'off');
    expect(apis.calls).toEqual(['PATCH /v1/servers/s1 {"idleStopMinutes":45}', 'PATCH /v1/servers/s1 {"idleStopMinutes":0}']);
    expect(out).toEqual([
      's1 stops after 45 minutes with nobody playing, from its next start.',
      's1 never stops for being idle, from its next start.',
    ]);
    await expect(cmd.setIdle('s1', 'soon')).rejects.toBeInstanceOf(CommandError);
    await expect(cmd.setIdle('s1', '-5')).rejects.toBeInstanceOf(CommandError);
  });

  it('creates on a channel and moves servers between channels', async () => {
    const apis = fakeApis();
    const { out, cmd } = run(apis);
    await cmd.create({ game: 'minecraft-java', version: '1.21.4', channel: 'canary', wait: false });
    await cmd.setChannel('s1', 'stable');
    expect(apis.calls).toEqual([
      'POST /v1/servers {"game":"minecraft-java","version":"1.21.4","agentChannel":"canary"}',
      'PATCH /v1/servers/s1 {"agentChannel":"stable"}',
    ]);
    expect(out.at(-1)).toBe('s1 is on the stable channel; it takes effect on the next start.');
  });

  describe('status', () => {
    async function status(state: Partial<ServerView>) {
      const { out, cmd } = run(fakeApis([state]));
      await cmd.status('s1');
      return out;
    }

    it("gives admins the whole record: owner, agent, channel, instance, the backup's size, the restore", async () => {
      const apis = fakeApis([], {
        admin: {
          record: record({
            status: 'RUNNING',
            ownerId: 'u-1',
            agentState: 'ready',
            agentVersion: '2026.10.06-de42566',
            agentChannel: 'canary',
            instanceId: 'i-1',
            instanceState: 'running',
            publicIp: '35.1.2.3',
            lastBackupAt: '2026-10-04T12:01:00.000Z',
            lastBackupBytes: 3 * 2 ** 20,
            restoreKey: 'accepted/01K6ABCDEF0123456789ABCDEF.tar.gz',
            restoreSource: 'upload',
          }),
        },
      });
      const { out, cmd } = run(apis);
      await cmd.status('s1');
      expect(apis.calls).toEqual(['GET /v1/admin/servers/s1']);
      expect(out).toEqual([
        'server      s1',
        'owner       u-1',
        'game        minecraft-java 1.21.4',
        'status      RUNNING',
        'agent       ready (2026.10.06-de42566)',
        'channel     canary',
        'idle stop   stops after 30 minutes with nobody playing',
        'instance    i-1 (running)',
        'join at     35.1.2.3:25565',
        'last backup 2026-10-04T12:01:00.000Z (3.0 MiB)',
        'restore     upload 01K6ABCDEF0123456789ABCDEF on the next start',
      ]);
    });

    it('falls back to what owners and members see for anyone else', async () => {
      const apis = fakeApis([{ status: 'STOPPED' }]);
      await run(apis).cmd.status('s1');
      expect(apis.calls).toEqual(['GET /v1/admin/servers/s1', 'GET /v1/servers/s1']);
    });

    it('shows the server as its owners and members see it', async () => {
      expect(await status({ status: 'RUNNING', gameState: 'ready', address: '35.1.2.3', role: 'member' })).toEqual([
        'server      s1',
        'you are     member',
        'game        minecraft-java 1.21.4',
        'status      RUNNING',
        'game state  ready',
        'idle stop   stops after 30 minutes with nobody playing',
        'join at     35.1.2.3:25565',
      ]);
    });

    it('shows why the server last stopped, and whether cleanly', async () => {
      expect(await status({ status: 'STOPPED', lastStoppedAt: '2026-10-05T12:00:00Z', stopReason: 'no players for 30 minutes' })).toContain(
        'last stop   2026-10-05T12:00:00Z: no players for 30 minutes',
      );
      expect(await status({ status: 'STOPPED', lastStoppedAt: '2026-10-05T12:00:00Z', lastStopClean: false })).toContain(
        'last stop   2026-10-05T12:00:00Z (not clean)',
      );
    });

    it('shows the last backup, a pending restore and when it was destroyed', async () => {
      const out = await status({
        status: 'DESTROYED',
        lastBackupAt: '2026-10-04T12:01:00.000Z',
        restorePending: true,
        destroyedAt: '2026-10-06T11:00:00.000Z',
        idleStopMinutes: 0,
      });
      expect(out).toContain('last backup 2026-10-04T12:01:00.000Z');
      expect(out).toContain('restore     pending: replaces the game data on the next start');
      expect(out).toContain('destroyed   2026-10-06T11:00:00.000Z');
      expect(out).toContain('idle stop   never stops for being idle');
    });
  });

  describe('destroy', () => {
    function runDestroy(states: Partial<ServerView>[], answer = 's1') {
      const apis = fakeApis(states);
      const asked: string[] = [];
      const { out, cmd } = run(apis, { ask: async (q) => (asked.push(q), answer) });
      const posts = () => apis.calls.filter((c) => c.startsWith('POST'));
      return { out, asked, cmd, posts };
    }

    const stopped = { status: 'STOPPED' as const, lastBackupAt: '2026-10-06T10:00:00.000Z' };

    it('shows what goes, asks for the ID back, destroys, and follows it to DESTROYED', async () => {
      const { out, asked, cmd, posts } = runDestroy([stopped, { status: 'DESTROYING' }, { status: 'DESTROYED' }]);
      await cmd.destroy('s1', { yes: false, wait: true });
      expect(asked).toEqual(['Type the server ID to destroy it: ']);
      expect(posts()).toEqual(['POST /v1/servers/s1/destroy']);
      expect(out).toEqual([
        'This destroys s1 (minecraft-java 1.21.4, STOPPED): its instance and data volume.',
        'Its backups are kept; the newest is from 2026-10-06T10:00:00.000Z.',
        'Destroying s1.',
        '  DESTROYING',
        '  DESTROYED',
        'Destroyed. Its backups are kept: `hearth backups s1`.',
      ]);
    });

    it('says when a server was already destroyed, asking nothing', async () => {
      const { out, asked, cmd, posts } = runDestroy([{ status: 'DESTROYED', destroyedAt: '2026-10-06T11:00:00.000Z' }]);
      await cmd.destroy('s1', { yes: false, wait: true });
      expect(out).toEqual(['s1 was already destroyed on 2026-10-06T11:00:00.000Z.']);
      expect(asked).toEqual([]);
      expect(posts()).toEqual([]);
    });

    it('warns plainly when there are no backups', async () => {
      const { out, cmd } = runDestroy([{ status: 'STOPPED' }]);
      await cmd.destroy('s1', { yes: true, wait: false });
      expect(out[1]).toBe('It has no backups: its game data will be gone for good.');
    });

    it("doesn't destroy when the typed ID doesn't match", async () => {
      const { cmd, posts } = runDestroy([stopped], 's2');
      await expect(cmd.destroy('s1', { yes: false, wait: false })).rejects.toThrow('Not destroyed');
      expect(posts()).toEqual([]);
    });

    it('skips the question with --yes', async () => {
      const { asked, cmd, posts } = runDestroy([stopped]);
      await cmd.destroy('s1', { yes: true, wait: false });
      expect(asked).toEqual([]);
      expect(posts()).toEqual(['POST /v1/servers/s1/destroy']);
    });

    it.each(['RUNNING', 'STARTING', 'STOPPING'] as const)('refuses a %s server before asking anything', async (status) => {
      const { asked, cmd, posts } = runDestroy([{ status }]);
      await expect(cmd.destroy('s1', { yes: false, wait: false })).rejects.toThrow(/stop it before destroying it/);
      expect(asked).toEqual([]);
      expect(posts()).toEqual([]);
    });

    it('fails with the reason if the destroy ends FAILED', async () => {
      const { cmd } = runDestroy([stopped, { status: 'DESTROYING' }, { status: 'FAILED', statusMessage: 'Error: boom' }]);
      await expect(cmd.destroy('s1', { yes: true, wait: true })).rejects.toThrow('Failed: Error: boom');
    });
  });

  describe('create --upload', () => {
    const UPLOAD = '01K6ABCDEF0123456789ABCDEF';

    /** /v1 routes that hand out an upload form, report the given statuses in turn, and create. */
    function uploadApis(statuses: UploadStatus[]) {
      const calls: string[] = [];
      let i = 0;
      const api = recorder(calls, (method, path) => {
        if (path === '/v1/uploads') return { uploadId: UPLOAD, url: 'https://s3/', fields: { key: 'k' } };
        if (method === 'GET') return statuses[Math.min(i++, statuses.length - 1)];
        return { serverId: 's1', status: 'PROVISIONING' };
      });
      return { api, calls };
    }

    function runUpload(apis: { api: Api }, bytes = 3 * 2 ** 20) {
      const sent: string[] = [];
      const { out, cmd } = run(apis, { fileSize: async () => bytes, sendUpload: async (form, file) => void sent.push(`${form.url} ${file}`) });
      return { out, sent, cmd };
    }

    // Built with the running OS's separator: basename() splits on "\" only on Windows, and CI runs Linux.
    const file = join('uploads', 'MyWorld.zip');
    const opts = { game: 'minecraft-java', version: '26.3', file, wait: false };

    it('uploads, waits for repack to accept it, then creates from it', async () => {
      const apis = uploadApis([
        { uploadId: UPLOAD, status: 'repacking' },
        { uploadId: UPLOAD, status: 'accepted', bytes: 2 * 2 ** 20 },
      ]);
      const { out, sent, cmd } = runUpload(apis);
      await cmd.create(opts);
      expect(sent).toEqual([`https://s3/ ${file}`]);
      expect(apis.calls).toEqual([
        'POST /v1/uploads {"game":"minecraft-java"}',
        `GET /v1/uploads/${UPLOAD}`,
        `GET /v1/uploads/${UPLOAD}`,
        `POST /v1/servers {"game":"minecraft-java","version":"26.3","upload":"${UPLOAD}"}`,
      ]);
      expect(out).toEqual([
        'Uploading MyWorld.zip (3.0 MiB)…',
        'Uploaded. Checking it…',
        'Accepted (2.0 MiB after repacking).',
        `Creating s1 (minecraft-java 26.3) from upload ${UPLOAD}. The first start takes a few minutes.`,
      ]);
    });

    it("stops with repack's reason and creates nothing when the upload is rejected", async () => {
      const apis = uploadApis([{ uploadId: UPLOAD, status: 'rejected', reason: 'no level.dat found' }]);
      await expect(runUpload(apis).cmd.create(opts)).rejects.toThrow('The upload was rejected: no level.dat found');
      expect(apis.calls.some((c) => c.startsWith('POST /v1/servers'))).toBe(false);
    });

    it('refuses a file over the limit before asking for a form', async () => {
      const apis = uploadApis([]);
      await expect(runUpload(apis, 5 * 2 ** 30).cmd.create(opts)).rejects.toThrow(/uploads can be at most 4096.0 MiB/);
      expect(apis.calls).toEqual([]);
    });

    it('refuses both a file and an upload ID', async () => {
      await expect(runUpload(uploadApis([])).cmd.create({ ...opts, upload: UPLOAD })).rejects.toBeInstanceOf(CommandError);
    });

    it('creates from an accepted upload', async () => {
      const apis = fakeApis();
      const { out, cmd } = run(apis);
      await cmd.create({ game: 'minecraft-java', version: '26.3', upload: UPLOAD, wait: false });
      expect(apis.calls).toEqual([`POST /v1/servers {"game":"minecraft-java","version":"26.3","upload":"${UPLOAD}"}`]);
      expect(out[0]).toMatch(/from upload 01K6ABCDEF0123456789ABCDEF/);
    });
  });

  it('list gives admins every server, following cursors', async () => {
    const apis = fakeApis([], {
      admin: { pages: [[record({ serverId: 'b', status: 'RUNNING', publicIp: '35.1.2.3', agentState: 'ready' })], [record({ serverId: 'a' })]] },
    });
    const { out, cmd } = run(apis);
    await cmd.list();
    expect(apis.calls).toEqual(['GET /v1/admin/servers {"limit":"100"}', 'GET /v1/admin/servers {"limit":"100","cursor":"c1"}']);
    expect(out[0]).toMatch(/^SERVER\s+GAME\s+VERSION\s+STATUS\s+AGENT\s+ADDRESS$/);
    expect(out[1]).toMatch(/^a\s+minecraft-java\s+1\.21\.4\s+STOPPED\s+-\s+-$/);
    expect(out[2]).toMatch(/^b .*RUNNING\s+ready\s+35\.1\.2\.3:25565$/);
  });

  it('list --all asks for destroyed servers too', async () => {
    const apis = fakeApis([], { admin: { pages: [[record({ serverId: 'gone', status: 'DESTROYED' })]] } });
    const { out, cmd } = run(apis);
    await cmd.list(true);
    expect(apis.calls).toEqual(['GET /v1/admin/servers {"limit":"100","all":"true"}']);
    expect(out[1]).toMatch(/^gone .*DESTROYED/);
  });

  it("list gives anyone else their own servers, as they see them", async () => {
    const apis = fakeApis([], { mine: [view({ serverId: 'mine', status: 'RUNNING', gameState: 'ready', address: '35.1.2.3', role: 'member' })] });
    const { out, cmd } = run(apis);
    await cmd.list(true);
    expect(apis.calls).toEqual(['GET /v1/admin/servers {"limit":"100","all":"true"}', 'GET /v1/servers {"all":"true"}']);
    expect(out[0]).toMatch(/^SERVER\s+GAME\s+VERSION\s+STATUS\s+GAME STATE\s+ADDRESS$/);
    expect(out[1]).toMatch(/^mine .*RUNNING\s+ready\s+35\.1\.2\.3:25565$/);
    const none = run(fakeApis());
    await none.cmd.list();
    expect(none.out).toEqual(['No servers.']);
  });

  it('approves a user and takes it back', async () => {
    const apis = fakeApis();
    const { out, cmd } = run(apis);
    await cmd.approve('u-1', true);
    await cmd.approve('u-1', false);
    expect(apis.calls).toEqual(['POST /v1/admin/users/u-1/approval {"approved":true}', 'POST /v1/admin/users/u-1/approval {"approved":false}']);
    expect(out).toEqual([
      'Friend is approved: they can create up to 3 servers.',
      "Friend is no longer approved: they can't create servers (the ones they have keep running).",
    ]);
  });

  it('fleet-check prints each finding, with the untracked instances to fix', async () => {
    const report: FleetReport = {
      stuck: [],
      failed: ['s1'],
      mismatched: [],
      untracked: [{ instanceId: 'i-1', region: 'us-west-2', state: 'running', launchedAt: '2026-10-02T19:00:56.000Z', serverId: 's9' }],
      running: 2,
    };
    const { out, cmd } = run(fakeApis(), { fleetCheck: async () => report });
    await cmd.fleetCheck();
    expect(out).toEqual([
      'running     2',
      'stuck       none',
      'failed      s1',
      'mismatched  none',
      'untracked   1',
      '  i-1  us-west-2  running  launched 2026-10-02T19:00:56.000Z  tagged server s9',
    ]);
  });

  it('fleet-check says when all is clear', async () => {
    const report: FleetReport = { stuck: [], failed: [], mismatched: [], untracked: [], running: 0 };
    const { out, cmd } = run(fakeApis(), { fleetCheck: async () => report });
    await cmd.fleetCheck();
    expect(out.at(-1)).toBe('All clear.');
  });
});
