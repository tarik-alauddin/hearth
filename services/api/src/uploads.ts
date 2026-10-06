import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { newId as defaultNewId } from '@hearth/core';
import {
  GAMES,
  MAX_UPLOAD_BYTES,
  landingKey,
  type CreateUploadResponse,
  type GameId,
} from '@hearth/shared';
import { OperationError } from './servers/operations.js';

// The form is short-lived: the client uploads right after asking for it.
const FORM_SECONDS = 900;

/** The uploads bucket, as the admin routes see it. */
export interface UploadStorage {
  /** A presigned POST form for `landingKey(game, uploadId)` that S3 refuses for files over the cap. */
  form(game: GameId, uploadId: string): Promise<Pick<CreateUploadResponse, 'url' | 'fields' | 'expiresAt'>>;
}

/**
 * A POST form rather than a PUT link: its signed policy lets S3 enforce the size cap (a PUT link
 * can't), and a browser can submit it directly.
 */
export function s3UploadStorage(opts: {
  bucket: string;
  region: string;
  presign?: typeof createPresignedPost;
  now?: () => Date;
}): UploadStorage {
  const { bucket, region, presign = createPresignedPost, now = () => new Date() } = opts;
  const client = new S3Client({ region });
  return {
    async form(game, uploadId) {
      const expiresAt = new Date(now().getTime() + FORM_SECONDS * 1000).toISOString();
      const { url, fields } = await presign(client, {
        Bucket: bucket,
        Key: landingKey(game, uploadId),
        Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]],
        Expires: FORM_SECONDS,
      });
      return { url, fields, expiresAt };
    },
  };
}

/** Starting uploads: the one implementation, for the admin routes now and the UI later. */
export function uploadOperations({
  uploads,
  now = () => new Date(),
  newId = defaultNewId,
}: {
  uploads: UploadStorage;
  now?: () => Date;
  newId?: (now: Date) => string;
}) {
  return {
    /** A new upload ID and the form to upload to it. The ID is unguessable: it names the upload later. */
    async createUpload(request: unknown): Promise<CreateUploadResponse> {
      if (typeof request !== 'object' || request === null) throw new OperationError(400, 'Body must be a JSON object');
      const { game, ...rest } = request as Record<string, unknown>;
      const unknown = Object.keys(rest);
      if (unknown.length) throw new OperationError(400, `Unknown fields: ${unknown.join(', ')}`);
      if (!(GAMES as readonly unknown[]).includes(game)) throw new OperationError(400, `Unknown game; one of ${GAMES.join(', ')}`);
      const uploadId = newId(now());
      return { uploadId, maxBytes: MAX_UPLOAD_BYTES, ...(await uploads.form(game as GameId, uploadId)) };
    },
  };
}
