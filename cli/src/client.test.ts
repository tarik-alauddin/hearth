import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, sendUpload, userApiClient } from './client.js';

describe('sendUpload', () => {
  async function file(content: string) {
    const path = join(await mkdtemp(join(tmpdir(), 'upload-')), 'MyWorld.zip');
    await writeFile(path, content);
    return path;
  }

  it("POSTs the form's fields first and the file last, as S3 requires", async () => {
    let sent: { url: string; entries: [string, FormDataEntryValue][] } | undefined;
    const fetch = (async (url: string, init: RequestInit) => {
      sent = { url, entries: [...(init.body as FormData).entries()] };
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;

    await sendUpload({ url: 'https://bucket.s3/', fields: { key: 'landing/x', Policy: 'p' } }, await file('zipdata'), fetch);
    expect(sent?.url).toBe('https://bucket.s3/');
    expect(sent?.entries.map(([name]) => name)).toEqual(['key', 'Policy', 'file']);
    const blob = sent?.entries[2]?.[1] as File;
    expect(blob.name).toBe('MyWorld.zip');
    expect(await blob.text()).toBe('zipdata');
  });

  it("fails with S3's message", async () => {
    const fetch = (async () =>
      new Response('<Error><Code>EntityTooLarge</Code><Message>Your proposed upload exceeds the maximum allowed size</Message></Error>', {
        status: 400,
      })) as typeof globalThis.fetch;
    await expect(sendUpload({ url: 'https://bucket.s3/', fields: {} }, await file('x'), fetch)).rejects.toThrow(
      'The upload failed: Your proposed upload exceeds the maximum allowed size',
    );
  });
});

function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('userApiClient', () => {
  it('sends the ID token as a bearer token, fetched for each request', async () => {
    const { fetch, calls } = fakeFetch(200, '{"userId":"u-1"}');
    let n = 0;
    const api = userApiClient({ baseUrl: 'https://abc.example.com', idToken: async () => `token-${++n}`, fetch });
    expect(await api.get('/v1/me')).toEqual({ userId: 'u-1' });
    await api.post('/v1/servers', { game: 'minecraft-java' });
    expect(calls.map((c) => (c.init.headers as Record<string, string>).authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(calls[1]?.init.body).toBe('{"game":"minecraft-java"}');
    await api.get('/v1/admin/servers', { limit: '100', cursor: undefined });
    expect(calls[2]?.url).toBe('https://abc.example.com/v1/admin/servers?limit=100');
  });

  it('turns error responses into ApiError', async () => {
    const { fetch } = fakeFetch(401, '{"message":"Unauthorized"}');
    const api = userApiClient({ baseUrl: 'https://abc.example.com', idToken: async () => 't', fetch });
    await expect(api.get('/v1/me')).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
    await expect(api.get('/v1/me')).rejects.toBeInstanceOf(ApiError);
  });
});
