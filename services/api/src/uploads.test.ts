import { GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@hearth/shared';
import type { Actor } from './authz.js';
import { s3UploadStorage, uploadOperations, type StoredUpload, type UploadStorage } from './uploads.js';

const NOW = new Date('2026-10-05T12:00:00Z');

describe('s3UploadStorage', () => {
  it('presigns a 15-minute POST form for the landing key, capped at the upload limit and naming its uploader', async () => {
    // Real presigning, offline: it only needs credentials to sign with.
    const env = { ...process.env };
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'secret' });
    try {
      const storage = s3UploadStorage({ bucket: 'hearth-dev-uploads', region: 'us-west-2', now: () => NOW });
      const form = await storage.form('minecraft-java', 'U1', 'u-1');
      expect(form.url).toBe('https://hearth-dev-uploads.s3.us-west-2.amazonaws.com/');
      expect(form.fields.key).toBe('landing/minecraft-java/U1');
      expect(form.expiresAt).toBe('2026-10-05T12:15:00.000Z');
      const policy = JSON.parse(Buffer.from(form.fields.Policy!, 'base64').toString('utf8')) as {
        expiration: string;
        conditions: unknown[];
      };
      expect(policy.conditions).toContainEqual(['content-length-range', 1, MAX_UPLOAD_BYTES]);
      expect(policy.conditions).toContainEqual({ key: 'landing/minecraft-java/U1' });
      // The uploader is a form field and a condition of the signed policy: S3 refuses any other.
      expect(form.fields['x-amz-meta-uploader']).toBe('u-1');
      expect(policy.conditions).toContainEqual({ 'x-amz-meta-uploader': 'u-1' });
    } finally {
      process.env = env;
    }
  });
});

describe('s3UploadStorage status', () => {
  const ID = '01K6ABCDEF0123456789ABCDEF';

  /** A bucket holding just these keys (a rejection's body is its JSON), each uploaded by `uploader`. */
  function bucket(objects: Record<string, string>, uploader?: string) {
    const Metadata = uploader ? { uploader } : {};
    const s3 = {
      send: async (command: HeadObjectCommand | GetObjectCommand) => {
        const body = objects[command.input.Key!];
        if (body === undefined) {
          throw command instanceof HeadObjectCommand
            ? new NotFound({ message: 'not found', $metadata: {} })
            : new NoSuchKey({ message: 'no such key', $metadata: {} });
        }
        return command instanceof HeadObjectCommand
          ? { ContentLength: body.length, Metadata }
          : { Body: { transformToString: async () => body }, Metadata };
      },
    };
    return s3UploadStorage({ bucket: 'b', region: 'us-west-2', s3: s3 as never });
  }

  it.each([
    [{ [`accepted/${ID}.tar.gz`]: 'x'.repeat(42) }, { uploadId: ID, status: 'accepted', bytes: 42 }],
    [{ [`rejected/${ID}.json`]: '{"reason":"no level.dat","at":"t"}' }, { uploadId: ID, status: 'rejected', reason: 'no level.dat' }],
    [{ [`landing/minecraft-java/${ID}`]: 'zip' }, { uploadId: ID, status: 'repacking' }],
  ])('reads %j as %j, with its uploader', async (objects, status) => {
    expect(await bucket(objects, 'u-1').status(ID)).toEqual({ status, uploader: 'u-1' });
    expect(await bucket(objects).status(ID)).toEqual({ status }); // uploaded before uploaders were recorded
  });

  it('knows nothing of an upload with no files', async () => {
    expect(await bucket({}).status(ID)).toBeUndefined();
  });
});

describe('uploadOperations', () => {
  const ID = '01K6ABCDEF0123456789ABCDEF';
  const user: Actor = { kind: 'user', userId: 'u-1' };
  const forms: string[] = [];
  const stored: Record<string, StoredUpload> = { [ID]: { status: { uploadId: ID, status: 'repacking' }, uploader: 'u-1' } };
  const uploads: UploadStorage = {
    form: async (game, uploadId, uploader) => {
      forms.push(`${game} ${uploadId} ${uploader}`);
      return { url: 'https://bucket/', fields: { key: `landing/${game}/${uploadId}` }, expiresAt: 'later' };
    },
    status: async (uploadId) => stored[uploadId],
    accepted: (uploadId) => ({ bucket: 'uploads', key: `accepted/${uploadId}.tar.gz` }),
    downloadUrl: async (key) => `https://uploads.example/${key}`,
  };
  const ops = uploadOperations({ uploads, now: () => NOW, newId: () => 'U1' });

  it("starts an upload: a new ID and a form for that game's landing key, naming the uploader", async () => {
    expect(await ops.createUpload(user, { game: 'minecraft-java' })).toEqual({
      uploadId: 'U1',
      url: 'https://bucket/',
      fields: { key: 'landing/minecraft-java/U1' },
      maxBytes: MAX_UPLOAD_BYTES,
      expiresAt: 'later',
    });
    expect(forms).toEqual(['minecraft-java U1 u-1']);
    await ops.createUpload({ kind: 'admin', id: 'arn:admin' }, { game: 'minecraft-java' });
    expect(forms.at(-1)).toBe('minecraft-java U1 arn:admin');
    await expect(ops.createUpload({ kind: 'agent', serverId: 's1', instanceId: 'i-1' }, { game: 'minecraft-java' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("shows an upload's status to its uploader and admins; to anyone else it doesn't exist", async () => {
    expect(await ops.uploadStatus(user, ID)).toEqual({ uploadId: ID, status: 'repacking' });
    expect(await ops.uploadStatus({ kind: 'admin', id: 'arn:admin' }, ID)).toEqual({ uploadId: ID, status: 'repacking' });
    const notFound = { statusCode: 404, message: `No upload ${ID} (never uploaded, or expired)` };
    await expect(ops.uploadStatus({ kind: 'user', userId: 'u-2' }, ID)).rejects.toMatchObject(notFound);
    await expect(ops.uploadStatus(user, '01K6NKNWN00000000000000000')).rejects.toMatchObject({ statusCode: 404 });
    await expect(ops.uploadStatus(user, '../etc/passwd')).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ['an unknown game', { game: 'tetris' }],
    ['no game', {}],
    ['an unknown field', { game: 'minecraft-java', serverId: 's1' }],
    ['a non-object body', 'minecraft-java'],
  ])('returns 400 for %s', async (_, body) => {
    await expect(ops.createUpload(user, body)).rejects.toMatchObject({ statusCode: 400 });
  });
});
