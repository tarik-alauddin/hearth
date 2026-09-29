import { describe, expect, it } from 'vitest';
import type { ServerRecord } from '@hearth/shared';
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

  it('stop reports whether the world was saved', async () => {
    const { api } = fakeApi([{ status: 'STOPPING' }, { status: 'STOPPED', lastStopClean: false }]);
    const { out, cmd } = run(api);
    await cmd.stop('s1', true);
    expect(out.at(-1)).toMatch(/did not report a clean stop/);
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
});
