import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FleetReport, ServerRecord, UploadStatus } from '@hearth/shared';
import type { Api } from './client.js';
import { CommandError, commands } from './commands.js';

function server(overrides: Partial<ServerRecord>): ServerRecord {
  return {
    serverId: 's1',
    ownerId: 'o',
    game: 'minecraft-java',
    region: 'us-west-2',
    status: 'STARTING',
    version: '1.21.4',
    autoUpdate: false,
    ...overrides,
  };
}

/** An API whose GET /admin/servers/s1 walks through the given states, one per poll. */
function fakeApi(states: Partial<ServerRecord>[], pages: ServerRecord[][] = []) {
  const posts: string[] = [];
  const gets: string[] = [];
  let i = 0;
  const api: Api = {
    get: async <T>(path: string, query?: Record<string, string | undefined>) => {
      gets.push(`${path} ${JSON.stringify(query ?? {})}`);
      if (path === '/admin/servers') {
        const page = pages.shift() ?? [];
        return { servers: page, ...(pages.length ? { cursor: `c${pages.length}` } : {}) } as T;
      }
      return server(states[Math.min(i++, states.length - 1)] ?? {}) as T;
    },
    post: async <T>(path: string, body?: unknown) => {
      posts.push(`${path} ${JSON.stringify(body ?? null)}`);
      return { serverId: 's1', status: path.endsWith('/stop') ? 'STOPPING' : 'STARTING' } as T;
    },
  };
  return { api, posts, gets };
}

function run(api: Api) {
  const out: string[] = [];
  return { out, cmd: commands({ api, print: (l) => out.push(l), sleep: async () => {}, pollMs: 1, timeoutMs: 100 }) };
}

describe('commands', () => {
  it('create waits until running with an IP and prints the join address', async () => {
    const { api, posts } = fakeApi([
      { status: 'PROVISIONING' },
      { status: 'STARTING', agentState: 'starting' },
      { status: 'RUNNING', agentState: 'ready' }, // no IP yet: keep waiting
      { status: 'RUNNING', agentState: 'ready', publicIp: '35.1.2.3' },
    ]);
    const { out, cmd } = run(api);
    await cmd.create({ game: 'minecraft-java', version: '1.21.4', wait: true });

    expect(posts).toEqual(['/admin/servers {"game":"minecraft-java","version":"1.21.4"}']);
    expect(out).toEqual([
      'Creating s1 (minecraft-java 1.21.4). The first start takes a few minutes.',
      '  PROVISIONING',
      '  STARTING · agent starting',
      '  RUNNING · agent ready',
      'Ready. Join at 35.1.2.3:25565   (server s1)',
    ]);
  });

  it('fails with the reason when the server fails', async () => {
    const { api } = fakeApi([{ status: 'FAILED', statusMessage: 'AgentError: image pull failed' }]);
    await expect(run(api).cmd.start('s1', true)).rejects.toThrow('Failed: AgentError: image pull failed');
  });

  it('gives up after the timeout', async () => {
    const { api } = fakeApi([{ status: 'STARTING' }]);
    await expect(run(api).cmd.start('s1', true)).rejects.toBeInstanceOf(CommandError);
  });

  it('stop reports whether the game was saved', async () => {
    const { api } = fakeApi([{ status: 'STOPPING' }, { status: 'STOPPED', lastStopClean: false }]);
    const { out, cmd } = run(api);
    await cmd.stop('s1', true);
    expect(out.at(-1)).toMatch(/did not report a clean stop/);
  });

  it('stop passes on what went wrong in an otherwise clean stop', async () => {
    const agentMessage = 'game saved, but the backup failed: upload: timeout';
    const { api } = fakeApi([{ status: 'STOPPING' }, { status: 'STOPPED', lastStopClean: true, agentMessage }]);
    const { out, cmd } = run(api);
    await cmd.stop('s1', true);
    expect(out.at(-1)).toBe(`Stopped. Game saved. Agent: ${agentMessage}`);
  });

  it('lists backups as a table, or says there are none', async () => {
    const backups = [
      { key: 'servers/s1/20261005T120000Z.tar.gz', takenAt: '2026-10-05T12:00:10.000Z', bytes: 3 * 2 ** 20 },
      { key: 'servers/s1/20261004T120000Z.tar.gz', takenAt: '2026-10-04T12:00:10.000Z', bytes: 2 ** 20 },
    ];
    const api = { get: async () => ({ backups }) } as unknown as Api;
    const { out, cmd } = run(api);
    await cmd.backups('s1');
    expect(out).toEqual([
      'TAKEN                     SIZE     KEY',
      '2026-10-05T12:00:10.000Z  3.0 MiB  servers/s1/20261005T120000Z.tar.gz',
      '2026-10-04T12:00:10.000Z  1.0 MiB  servers/s1/20261004T120000Z.tar.gz',
    ]);

    const empty = run({ get: async () => ({ backups: [] }) } as unknown as Api);
    await empty.cmd.backups('s1');
    expect(empty.out).toEqual(['No backups yet. One is taken each time the server stops.']);
  });

  it('requests a restore with an optional key and force, and cancels one', async () => {
    const posts: string[] = [];
    const api = {
      post: async (path: string, body?: unknown) => {
        posts.push(`${path} ${JSON.stringify(body ?? null)}`);
        return { serverId: 's1', restoreKey: 'servers/s1/20261004T120000Z.tar.gz' };
      },
    } as unknown as Api;
    const { out, cmd } = run(api);
    await cmd.restore('s1', undefined, false);
    await cmd.restore('s1', '20261004T120000Z.tar.gz', true);
    await cmd.cancelRestore('s1');
    expect(posts).toEqual([
      '/admin/servers/s1/restore {}',
      '/admin/servers/s1/restore {"key":"20261004T120000Z.tar.gz","force":true}',
      '/admin/servers/s1/restore/cancel null',
    ]);
    expect(out[0]).toBe('s1 will restore servers/s1/20261004T120000Z.tar.gz on its next start, replacing the current game data.');
    expect(out.at(-1)).toBe('No restore pending for s1.');
  });

  it('sets the version', async () => {
    const posts: string[] = [];
    const api = {
      post: async (path: string, body?: unknown) => {
        posts.push(`${path} ${JSON.stringify(body)}`);
        return { serverId: 's1', game: 'minecraft-java', version: '26.3' };
      },
    } as unknown as Api;
    const { out, cmd } = run(api);
    await cmd.setVersion('s1', '26.3');
    expect(posts).toEqual(['/admin/servers/s1/version {"version":"26.3"}']);
    expect(out).toEqual(['s1 runs minecraft-java 26.3 from its next start.']);
  });

  it('sets the idle limit in minutes, or off', async () => {
    const posts: string[] = [];
    const api = {
      post: async (path: string, body?: { idleStopMinutes: number }) => {
        posts.push(`${path} ${JSON.stringify(body)}`);
        return { serverId: 's1', idleStopMinutes: body?.idleStopMinutes };
      },
    } as unknown as Api;
    const { out, cmd } = run(api);
    await cmd.setIdle('s1', '45');
    await cmd.setIdle('s1', 'off');
    expect(posts).toEqual(['/admin/servers/s1/settings {"idleStopMinutes":45}', '/admin/servers/s1/settings {"idleStopMinutes":0}']);
    expect(out).toEqual([
      's1 stops after 45 minutes with nobody playing, from its next start.',
      's1 never stops for being idle, from its next start.',
    ]);
    await expect(cmd.setIdle('s1', 'soon')).rejects.toBeInstanceOf(CommandError);
    await expect(cmd.setIdle('s1', '-5')).rejects.toBeInstanceOf(CommandError);
  });

  it('status shows the idle limit, defaulting to 30 minutes', async () => {
    const { api } = fakeApi([{ status: 'RUNNING' }]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('idle stop   stops after 30 minutes with nobody playing');
  });

  it('status shows why the server last stopped', async () => {
    const { api } = fakeApi([
      { status: 'STOPPED', lastStoppedAt: '2026-10-05T12:00:00Z', stopReason: 'no players for 30 minutes' },
    ]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('last stop   2026-10-05T12:00:00Z: no players for 30 minutes');
  });

  it('status names a pending restore of an upload by its upload ID', async () => {
    const { api } = fakeApi([
      { status: 'STARTING', restoreKey: 'accepted/01K6ABCDEF0123456789ABCDEF.tar.gz', restoreSource: 'upload' },
    ]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('restore     upload 01K6ABCDEF0123456789ABCDEF on the next start');
  });

  it('status shows a pending restore', async () => {
    const { api } = fakeApi([{ status: 'STOPPED', restoreKey: 'servers/s1/20261004T120000Z.tar.gz' }]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('restore     servers/s1/20261004T120000Z.tar.gz on the next start');
  });

  it('status shows the last backup', async () => {
    const { api } = fakeApi([{ status: 'STOPPED', lastBackupAt: '2026-10-04T12:01:00.000Z', lastBackupBytes: 3 * 2 ** 20 }]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('last backup 2026-10-04T12:01:00.000Z (3.0 MiB)');
  });

  describe('destroy', () => {
    /** An API whose GET walks through `states` (the last one repeats), recording POSTs. */
    function destroyApi(states: Partial<ServerRecord>[]) {
      const posts: string[] = [];
      let i = 0;
      const api = {
        get: async () => server(states[Math.min(i++, states.length - 1)] ?? {}),
        post: async (path: string) => {
          posts.push(path);
          return { serverId: 's1', status: 'DESTROYING' };
        },
      } as unknown as Api;
      return { api, posts };
    }

    function runDestroy(api: Api, answer = 's1') {
      const out: string[] = [];
      const asked: string[] = [];
      const cmd = commands({
        api,
        print: (l) => out.push(l),
        sleep: async () => {},
        pollMs: 1,
        timeoutMs: 100,
        ask: async (q) => (asked.push(q), answer),
      });
      return { out, asked, cmd };
    }

    const stopped = { status: 'STOPPED' as const, lastBackupAt: '2026-10-06T10:00:00.000Z' };

    it('shows what goes, asks for the ID back, destroys, and follows it to DESTROYED', async () => {
      const { api, posts } = destroyApi([stopped, { status: 'DESTROYING' }, { status: 'DESTROYED' }]);
      const { out, asked, cmd } = runDestroy(api);
      await cmd.destroy('s1', { yes: false, wait: true });
      expect(asked).toEqual(['Type the server ID to destroy it: ']);
      expect(posts).toEqual(['/admin/servers/s1/destroy']);
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
      const { api, posts } = destroyApi([{ status: 'DESTROYED', destroyedAt: '2026-10-06T11:00:00.000Z' }]);
      const { out, asked, cmd } = runDestroy(api);
      await cmd.destroy('s1', { yes: false, wait: true });
      expect(out).toEqual(['s1 was already destroyed on 2026-10-06T11:00:00.000Z.']);
      expect(asked).toEqual([]);
      expect(posts).toEqual([]);
    });

    it('warns plainly when there are no backups', async () => {
      const { api } = destroyApi([{ status: 'STOPPED' }]);
      const { out, cmd } = runDestroy(api);
      await cmd.destroy('s1', { yes: true, wait: false });
      expect(out[1]).toBe('It has no backups: its game data will be gone for good.');
    });

    it("doesn't destroy when the typed ID doesn't match", async () => {
      const { api, posts } = destroyApi([stopped]);
      const { cmd } = runDestroy(api, 's2');
      await expect(cmd.destroy('s1', { yes: false, wait: false })).rejects.toThrow('Not destroyed');
      expect(posts).toEqual([]);
    });

    it('skips the question with --yes', async () => {
      const { api, posts } = destroyApi([stopped]);
      const { asked, cmd } = runDestroy(api);
      await cmd.destroy('s1', { yes: true, wait: false });
      expect(asked).toEqual([]);
      expect(posts).toEqual(['/admin/servers/s1/destroy']);
    });

    it.each(['RUNNING', 'STARTING', 'STOPPING'] as const)('refuses a %s server before asking anything', async (status) => {
      const { api, posts } = destroyApi([{ status }]);
      const { asked, cmd } = runDestroy(api);
      await expect(cmd.destroy('s1', { yes: false, wait: false })).rejects.toThrow(/stop it before destroying it/);
      expect(asked).toEqual([]);
      expect(posts).toEqual([]);
    });

    it('fails with the reason if the destroy ends FAILED', async () => {
      const { api } = destroyApi([stopped, { status: 'DESTROYING' }, { status: 'FAILED', statusMessage: 'Error: boom' }]);
      const { cmd } = runDestroy(api);
      await expect(cmd.destroy('s1', { yes: true, wait: true })).rejects.toThrow('Failed: Error: boom');
    });
  });

  describe('create --upload', () => {
    const UPLOAD = '01K6ABCDEF0123456789ABCDEF';

    /** An API that hands out an upload form, reports the given statuses in turn, and creates. */
    function uploadApi(statuses: UploadStatus[]) {
      const calls: string[] = [];
      let i = 0;
      const api = {
        post: async (path: string, body?: unknown) => {
          calls.push(`POST ${path} ${JSON.stringify(body)}`);
          if (path === '/admin/uploads') return { uploadId: UPLOAD, url: 'https://s3/', fields: { key: 'k' } };
          return { serverId: 's1', status: 'PROVISIONING' };
        },
        get: async (path: string) => {
          calls.push(`GET ${path}`);
          return statuses[Math.min(i++, statuses.length - 1)];
        },
      } as unknown as Api;
      return { api, calls };
    }

    function runUpload(api: Api, bytes = 3 * 2 ** 20) {
      const out: string[] = [];
      const sent: string[] = [];
      const cmd = commands({
        api,
        print: (l) => out.push(l),
        sleep: async () => {},
        pollMs: 1,
        timeoutMs: 100,
        fileSize: async () => bytes,
        sendUpload: async (form, file) => {
          sent.push(`${form.url} ${file}`);
        },
      });
      return { out, sent, cmd };
    }

    // Built with the running OS's separator: basename() splits on "\" only on Windows, and CI runs Linux.
    const file = join('uploads', 'MyWorld.zip');
    const opts = { game: 'minecraft-java', version: '26.3', file, wait: false };

    it('uploads, waits for repack to accept it, then creates from it', async () => {
      const { api, calls } = uploadApi([
        { uploadId: UPLOAD, status: 'repacking' },
        { uploadId: UPLOAD, status: 'accepted', bytes: 2 * 2 ** 20 },
      ]);
      const { out, sent, cmd } = runUpload(api);
      await cmd.create(opts);
      expect(sent).toEqual([`https://s3/ ${file}`]);
      expect(calls).toEqual([
        'POST /admin/uploads {"game":"minecraft-java"}',
        `GET /admin/uploads/${UPLOAD}`,
        `GET /admin/uploads/${UPLOAD}`,
        `POST /admin/servers {"game":"minecraft-java","version":"26.3","upload":"${UPLOAD}"}`,
      ]);
      expect(out).toEqual([
        'Uploading MyWorld.zip (3.0 MiB)…',
        'Uploaded. Checking it…',
        'Accepted (2.0 MiB after repacking).',
        `Creating s1 (minecraft-java 26.3) from upload ${UPLOAD}. The first start takes a few minutes.`,
      ]);
    });

    it("stops with repack's reason and creates nothing when the upload is rejected", async () => {
      const { api, calls } = uploadApi([{ uploadId: UPLOAD, status: 'rejected', reason: 'no level.dat found' }]);
      const { cmd } = runUpload(api);
      await expect(cmd.create(opts)).rejects.toThrow('The upload was rejected: no level.dat found');
      expect(calls.some((c) => c.startsWith('POST /admin/servers'))).toBe(false);
    });

    it('refuses a file over the limit before asking for a form', async () => {
      const { api, calls } = uploadApi([]);
      const { cmd } = runUpload(api, 5 * 2 ** 30);
      await expect(cmd.create(opts)).rejects.toThrow(/uploads can be at most 4096.0 MiB/);
      expect(calls).toEqual([]);
    });

    it('refuses both a file and an upload ID', async () => {
      const { api } = uploadApi([]);
      const { cmd } = runUpload(api);
      await expect(cmd.create({ ...opts, upload: UPLOAD })).rejects.toBeInstanceOf(CommandError);
    });
  });

  it('creates from an accepted upload', async () => {
    const { api, posts } = fakeApi([{ status: 'RUNNING' }]);
    const { out, cmd } = run(api);
    await cmd.create({ game: 'minecraft-java', version: '26.3', upload: '01K6ABCDEF0123456789ABCDEF', wait: false });
    expect(posts[0]).toBe('/admin/servers {"game":"minecraft-java","version":"26.3","upload":"01K6ABCDEF0123456789ABCDEF"}');
    expect(out[0]).toMatch(/from upload 01K6ABCDEF0123456789ABCDEF/);
  });

  it('creates on a channel and moves servers between channels', async () => {
    const { api, posts } = fakeApi([{ status: 'RUNNING', publicIp: '1.2.3.4' }]);
    const { out, cmd } = run(api);
    await cmd.create({ game: 'minecraft-java', version: '1.21.4', channel: 'canary', wait: false });
    expect(posts[0]).toBe('/admin/servers {"game":"minecraft-java","version":"1.21.4","agentChannel":"canary"}');

    api.post = (async (path: string, body?: unknown) => {
      posts.push(`${path} ${JSON.stringify(body)}`);
      return { serverId: 's1', agentChannel: 'stable' };
    }) as Api['post'];
    await cmd.setChannel('s1', 'stable');
    expect(posts.at(-1)).toBe('/admin/servers/s1/settings {"agentChannel":"stable"}');
    expect(out.at(-1)).toBe('s1 is on the stable channel; it takes effect on the next start.');
  });

  it('does not wait with --no-wait', async () => {
    const { api, gets } = fakeApi([]);
    await run(api).cmd.start('s1', false);
    expect(gets).toEqual([]);
  });

  it('list follows cursors and prints a table', async () => {
    const { api, gets } = fakeApi(
      [],
      [[server({ serverId: 'b', status: 'RUNNING', publicIp: '35.1.2.3', agentState: 'ready' })], [server({ serverId: 'a', status: 'STOPPED' })]],
    );
    const { out, cmd } = run(api);
    await cmd.list();
    expect(gets).toEqual(['/admin/servers {"limit":"100"}', '/admin/servers {"limit":"100","cursor":"c1"}']);
    expect(out[0]).toMatch(/^SERVER\s+GAME\s+VERSION\s+STATUS\s+AGENT\s+ADDRESS$/);
    expect(out[1]).toMatch(/^a\s+minecraft-java\s+1\.21\.4\s+STOPPED\s+-\s+-$/);
    expect(out[2]).toMatch(/^b .*RUNNING\s+ready\s+35\.1\.2\.3:25565$/);
  });

  it('list --all asks for destroyed servers too', async () => {
    const { api, gets } = fakeApi([], [[server({ serverId: 'gone', status: 'DESTROYED' })]]);
    const { out, cmd } = run(api);
    await cmd.list(true);
    expect(gets).toEqual(['/admin/servers {"limit":"100","all":"true"}']);
    expect(out[1]).toMatch(/^gone .*DESTROYED/);
  });

  it('status shows when a server was destroyed', async () => {
    const { api } = fakeApi([{ status: 'DESTROYED', destroyedAt: '2026-10-06T11:00:00.000Z' }]);
    const { out, cmd } = run(api);
    await cmd.status('s1');
    expect(out).toContain('destroyed   2026-10-06T11:00:00.000Z');
  });

  it('fleet-check prints each finding, with the untracked instances to fix', async () => {
    const report: FleetReport = {
      stuck: [],
      failed: ['s1'],
      mismatched: [],
      untracked: [{ instanceId: 'i-1', region: 'us-west-2', state: 'running', launchedAt: '2026-10-02T19:00:56.000Z', serverId: 's9' }],
      running: 2,
    };
    const out: string[] = [];
    await commands({ api: fakeApi([]).api, fleetCheck: async () => report, print: (l) => out.push(l) }).fleetCheck();
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
    const out: string[] = [];
    await commands({ api: fakeApi([]).api, fleetCheck: async () => report, print: (l) => out.push(l) }).fleetCheck();
    expect(out.at(-1)).toBe('All clear.');
  });
});
