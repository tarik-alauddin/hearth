import { GetObjectCommand, HeadObjectCommand, NoSuchKey, NotFound, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { newId as defaultNewId, type UsersStore } from '@hearth/core';
import {
  GAMES,
  MAX_UPLOAD_BYTES,
  UPLOADER_METADATA,
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
import { AccessDenied, actorId, type Actor } from './authz.js';
import { OperationError } from './servers/operations.js';
import { check } from './validation.js';

// Forms and download links are short-lived: they're used right after they're made.
const FORM_SECONDS = 900;

/** An upload as the bucket records it: where repack is with it, and who uploaded it. */
export interface StoredUpload {
  status: UploadStatus;
  /** From the file's metadata; uploads made before it was recorded have none (admins only). */
  uploader?: string;
}

/** The uploads bucket, as the admin and agent routes see it. */
export interface UploadStorage {
  /**
   * A presigned POST form for `landingKey(game, uploadId)` that S3 refuses for files over the cap,
   * or naming anyone but `uploader`.
   */
  form(game: GameId, uploadId: string, uploader: string): Promise<Pick<CreateUploadResponse, 'url' | 'fields' | 'expiresAt'>>;
  /** Where repack is with an upload, read from the bucket; undefined if there's no trace of it. */
  status(uploadId: string): Promise<StoredUpload | undefined>;
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
      const uploader = (metadata: Record<string, string> | undefined) =>
        metadata?.[UPLOADER_METADATA] ? { uploader: metadata[UPLOADER_METADATA] } : {};
      const accepted = await head(acceptedKey(uploadId));
      if (accepted) {
        const { game } = accepted.metadata; // set by repack
        return {
          status: { uploadId, status: 'accepted', bytes: accepted.bytes, ...(game ? { game } : {}) },
          ...uploader(accepted.metadata),
        };
      }
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: rejectedKey(uploadId) }));
        const { reason } = JSON.parse(await out.Body!.transformToString()) as Rejection;
        return { status: { uploadId, status: 'rejected', reason }, ...uploader(out.Metadata) };
      } catch (err) {
        if (!(err instanceof NoSuchKey)) throw err;
      }
      // Still landed and not repacked yet. The game is in the landing key; try each.
      for (const game of GAMES) {
        const landed = await head(landingKey(game, uploadId));
        if (landed) return { status: { uploadId, status: 'repacking' }, ...uploader(landed.metadata) };
      }
      return undefined;
    },

    async form(game, uploadId, uploader) {
      const expiresAt = new Date(now().getTime() + FORM_SECONDS * 1000).toISOString();
      const { url, fields } = await presign(client, {
        Bucket: bucket,
        Key: landingKey(game, uploadId),
        Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES]],
        // Each field is also an exact-match condition of the signed policy: S3 refuses another uploader.
        Fields: { [`x-amz-meta-${UPLOADER_METADATA}`]: uploader },
        Expires: FORM_SECONDS,
      });
      return { url, fields, expiresAt };
    },
  };
}

/** Uploads: the one implementation, for /v1 (the CLI and the UI). */
export function uploadOperations({
  uploads,
  users,
  now = () => new Date(),
  newId = defaultNewId,
}: {
  uploads: UploadStorage;
  /** For user callers (/v1): only approved users may upload, as only they may create servers. */
  users?: Pick<UsersStore, 'getUser'>;
  now?: () => Date;
  newId?: (now: Date) => string;
}) {
  return {
    /**
     * A new upload ID and the form to upload to it, naming the actor as its uploader. The ID is
     * unguessable: it names the upload later.
     */
    async createUpload(actor: Actor, request: unknown): Promise<CreateUploadResponse> {
      if (actor.kind === 'agent') throw new OperationError(403, 'Agents cannot upload');
      const parsed = check(CreateUploadRequestSchema, request);
      if (!parsed.ok) throw new OperationError(400, parsed.message);
      // An upload costs storage and a repack run, and only serves to create a server: approved users only.
      if (actor.kind === 'user') {
        if (!users) throw new Error('No users store: this route takes no user callers');
        if (!(await users.getUser(actor.userId))?.approved) {
          throw new AccessDenied(403, "You can't upload until an admin approves your account");
        }
      }
      const uploadId = newId(now());
      return { uploadId, maxBytes: MAX_UPLOAD_BYTES, ...(await uploads.form(parsed.value.game, uploadId, actorId(actor))) };
    },

    /**
     * Whether repack has accepted or rejected an upload yet. 404 if it was never uploaded, has
     * expired, or is someone else's.
     */
    async uploadStatus(actor: Actor, uploadId: string): Promise<UploadStatus> {
      const stored = isUploadId(uploadId) ? await uploads.status(uploadId) : undefined;
      if (!stored || !mayUseUpload(actor, stored)) throw new OperationError(404, `No upload ${uploadId} (never uploaded, or expired)`);
      return stored.status;
    },
  };
}

/** Whether an actor may see or use an upload: its uploader, or any admin. */
export function mayUseUpload(actor: Actor, upload: StoredUpload): boolean {
  if (actor.kind === 'admin') return true;
  return actor.kind === 'user' && upload.uploader === actor.userId;
}
