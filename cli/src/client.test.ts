import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, apiClient, sendUpload } from './client.js';

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

const credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' });

function fakeFetch(status: number, body: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('apiClient', () => {
  it('signs requests for execute-api in the API region', async () => {
    const { fetch, calls } = fakeFetch(200, '{"servers":[]}');
    const api = apiClient({ baseUrl: 'https://abc.execute-api.us-west-2.amazonaws.com', region: 'us-west-2', credentials, fetch });
    await api.get('/admin/servers', { limit: '100', cursor: undefined });

    expect(calls[0]?.url).toBe('https://abc.execute-api.us-west-2.amazonaws.com/admin/servers?limit=100');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/execute-api\/aws4_request/);
    expect(headers['x-amz-security-token']).toBe('token');
  });

  it('sends JSON bodies', async () => {
    const { fetch, calls } = fakeFetch(202, '{"serverId":"s1","status":"PROVISIONING"}');
    const api = apiClient({ baseUrl: 'https://abc.example.com', region: 'us-west-2', credentials, fetch });
    expect(await api.post('/admin/servers', { game: 'minecraft-java', version: '1.21.4' })).toEqual({
      serverId: 's1',
      status: 'PROVISIONING',
    });
    expect(calls[0]?.init.body).toBe('{"game":"minecraft-java","version":"1.21.4"}');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('turns error responses into ApiError with the message', async () => {
    const { fetch } = fakeFetch(409, '{"message":"Server s1 is STOPPING and can\'t be started"}');
    const api = apiClient({ baseUrl: 'https://abc.example.com', region: 'us-west-2', credentials, fetch });
    await expect(api.post('/admin/servers/s1/start')).rejects.toMatchObject({
      status: 409,
      message: "Server s1 is STOPPING and can't be started",
    });
    await expect(api.post('/admin/servers/s1/start')).rejects.toBeInstanceOf(ApiError);
  });
});
