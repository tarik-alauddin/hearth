import type { WebConfig } from '@hearth/shared';
import { describe, expect, it } from 'vitest';
import { apiClient, ApiError } from './api';

const config: WebConfig = { env: 'dev', apiUrl: 'https://api.example', auth: { region: 'r', domain: 'd', clientId: 'c' } };

function server(statuses: number[], body: unknown = { ok: true }) {
  const seen: { url: string; auth: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: (init.headers as Record<string, string>).authorization!, init });
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status < 400 ? body : { message: 'Nope' }), { status });
  }) as unknown as typeof globalThis.fetch;
  return { seen, fetch };
}

describe('apiClient', () => {
  it('sends the ID token and a JSON body', async () => {
    const { seen, fetch } = server([200], { id: 's1' });
    const api = apiClient({ config, idToken: async () => 'id-1', signedOut: () => undefined, fetch });
    expect(await api.post('/v1/servers', { game: 'minecraft-java' })).toEqual({ id: 's1' });
    expect(seen[0]).toMatchObject({
      url: 'https://api.example/v1/servers',
      auth: 'Bearer id-1',
      init: { method: 'POST', body: '{"game":"minecraft-java"}' },
    });
  });

  it('refreshes once on a 401, then signs out on another', async () => {
    const forced: boolean[] = [];
    let out = 0;
    const idToken = async (force: boolean) => {
      forced.push(force);
      return force ? 'fresh' : 'stale';
    };
    const ok = server([401, 200]);
    expect(await apiClient({ config, idToken, signedOut: () => out++, fetch: ok.fetch }).get('/v1/me')).toEqual({ ok: true });
    expect(ok.seen.map((s) => s.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
    const refused = server([401, 401]);
    await expect(apiClient({ config, idToken, signedOut: () => out++, fetch: refused.fetch }).get('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(out).toBe(1);
    expect(forced).toEqual([false, true, false, true]);
  });

  it('signs out without calling when there is no session', async () => {
    const { seen, fetch } = server([]);
    let out = false;
    const api = apiClient({ config, idToken: async () => undefined, signedOut: () => (out = true), fetch });
    await expect(api.get('/v1/me')).rejects.toBeInstanceOf(ApiError);
    expect(out).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it("passes on the API's message", async () => {
    const { fetch } = server([403]);
    const api = apiClient({ config, idToken: async () => 't', signedOut: () => undefined, fetch });
    await expect(api.get('/v1/servers/s1')).rejects.toMatchObject({ status: 403, message: 'Nope' });
  });
});
