import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@hearth/shared';
import { s3UploadStorage, uploadOperations, type UploadStorage } from './uploads.js';

const NOW = new Date('2026-10-05T12:00:00Z');

describe('s3UploadStorage', () => {
  it('presigns a 15-minute POST form for the landing key, capped at the upload limit', async () => {
    // Real presigning, offline: it only needs credentials to sign with.
    const env = { ...process.env };
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret' });
    try {
      const storage = s3UploadStorage({ bucket: 'hearth-dev-uploads', region: 'us-west-2', now: () => NOW });
      const form = await storage.form('minecraft-java', 'U1');
      expect(form.url).toBe('https://hearth-dev-uploads.s3.us-west-2.amazonaws.com/');
      expect(form.fields.key).toBe('landing/minecraft-java/U1');
      expect(form.expiresAt).toBe('2026-10-05T12:15:00.000Z');
      const policy = JSON.parse(Buffer.from(form.fields.Policy!, 'base64').toString('utf8')) as {
        expiration: string;
        conditions: unknown[];
      };
      expect(policy.conditions).toContainEqual(['content-length-range', 1, MAX_UPLOAD_BYTES]);
      expect(policy.conditions).toContainEqual({ key: 'landing/minecraft-java/U1' });
    } finally {
      process.env = env;
    }
  });
});

describe('uploadOperations', () => {
  const forms: string[] = [];
  const uploads: UploadStorage = {
    form: async (game, uploadId) => {
      forms.push(`${game} ${uploadId}`);
      return { url: 'https://bucket/', fields: { key: `landing/${game}/${uploadId}` }, expiresAt: 'later' };
    },
  };
  const ops = uploadOperations({ uploads, now: () => NOW, newId: () => 'U1' });

  it("starts an upload: a new ID and a form for that game's landing key", async () => {
    expect(await ops.createUpload({ game: 'minecraft-java' })).toEqual({
      uploadId: 'U1',
      url: 'https://bucket/',
      fields: { key: 'landing/minecraft-java/U1' },
      maxBytes: MAX_UPLOAD_BYTES,
      expiresAt: 'later',
    });
    expect(forms).toEqual(['minecraft-java U1']);
  });

  it.each([
    ['an unknown game', { game: 'tetris' }],
    ['no game', {}],
    ['an unknown field', { game: 'minecraft-java', serverId: 's1' }],
    ['a non-object body', 'minecraft-java'],
  ])('returns 400 for %s', async (_, body) => {
    await expect(ops.createUpload(body)).rejects.toMatchObject({ statusCode: 400 });
  });
});
