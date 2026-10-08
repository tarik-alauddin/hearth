import { GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { newId as defaultNewId } from '@hearth/core';
import {
  GAMES,
  MAX_UPLOAD_BYTES,
  acceptedKey,
  isUploadId,
  landingKey,
  rejectedKey,
  type CreateUploadResponse,
  type GameId,
  type Rejection,
  type UploadStatus,
} from '@hearth/shared';
import { CreateUploadRequestSchema } from '@hearth/shared/api';
import { OperationError } from './servers/operations.js';
import { check } from './validation.js';

// Forms and download links are short-lived: they're used right after they're made.
const FORM_SECONDS = 900;

/** The uploads bucket, as the admin and agent routes see it. */
export interface UploadStorage {
  /** A presigned POST form for `landingKey(game, uploadId)` that S3 refuses for files over the cap. */
  form(game: GameId, uploadId: string): Promise<Pick<CreateUploadResponse, 'url' | 'fields' | 'expiresAt'>>;
  /** Where repack is with an upload, read from the bucket; undefined if there's no trace of it. */
  status(uploadId: string): Promise<UploadStatus | undefined>;
  /** Where an accepted upload's repacked archive is. */
  accepted(uploadId: string): { bucket: string; key: string };
  /** A short-lived link that downloads `key` (an accepted upload) and nothing else. */
  downloadUrl(key: string): Promise<string>;
}

/**
 * A POST form rather than a PUT link: its signed policy lets S3 enforce the size cap (a PUT link
 * can't), and a browser can submit it directly.
 */
export function s3UploadStorage(opts: {
  bucket: string;
  region: string;
  s3?: Pick<S3Client, 'send'>;
  presign?: typeof createPresignedPost;
  now?: () => Date;
}): UploadStorage {
  const { bucket, region, presign = createPresignedPost, now = () => new Date() } = opts;
  const client = new S3Client({ region });
  const s3 = opts.s3 ?? client;

  /** The object's size and metadata, or undefined if it doesn't exist. */
  async function head(key: string): Promise<{ bytes: number; metadata: Record<string, string> } | undefined> {
    try {
      const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { bytes: out.ContentLength ?? 0, metadata: out.Metadata ?? {} };
    } catch (err) {
      if (err instanceof NotFound) return undefined;
      throw err;
    }
  }

  return {
    accepted: (uploadId) => ({ bucket, key: acceptedKey(uploadId) }),

    // Signed by the caller (the agent config Lambda) when the agent fetches its config, like a backup's link.
    downloadUrl: (key) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: FORM_SECONDS }),

    async status(uploadId) {
      const accepted = await head(acceptedKey(uploadId));
      if (accepted) {
        const { game } = accepted.metadata; // set by repack
        return { uploadId, status: 'accepted', bytes: accepted.bytes, ...(game ? { game } : {}) };
      }
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rejectedKey(uploadId) }));
        const { reason } = JSON.parse(await out.Body!.transformToString()) as Rejection;
        return { uploadId, status: 'rejected', reason };
      } catch (err) {
        if (!(err instanceof NoSuchKey)) throw err;
      }
      // Still landed and not repacked yet. The game is in the landing key; try each.
      for (const game of GAMES) {
        if (await head(landingKey(game, uploadId))) return { uploadId, status: 'repacking' };
      }
      return undefined;
    },

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
      const parsed = check(CreateUploadRequestSchema, request);
      if (!parsed.ok) throw new OperationError(400, parsed.message);
      const uploadId = newId(now());
      return { uploadId, maxBytes: MAX_UPLOAD_BYTES, ...(await uploads.form(parsed.value.game, uploadId)) };
    },

    /** Whether repack has accepted or rejected an upload yet; 404 if it was never uploaded or has expired. */
    async uploadStatus(uploadId: string): Promise<UploadStatus> {
      if (!isUploadId(uploadId)) throw new OperationError(404, `No upload ${uploadId}`);
      const status = await uploads.status(uploadId);
      if (!status) throw new OperationError(404, `No upload ${uploadId} (never uploaded, or expired)`);
      return status;
    },
  };
}
