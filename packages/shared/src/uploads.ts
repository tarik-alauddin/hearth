import type { GameId } from './games.js';

// User uploads (e.g. game data to start a server with), in their own bucket: untrusted until the
// repack Lambda has unpacked, checked and repacked them.
//   landing/<game>/<uploadId>      as uploaded (the client writes it through a presigned form)
//   accepted/<uploadId>.tar.gz     repacked in backup format, ready to restore onto a server
//   rejected/<uploadId>.json       why repack refused it

/** Each environment's uploads bucket, in its home region. */
export const uploadsBucket = (env: string, account: string, region: string) => `hearth-${env}-uploads-${account}-${region}`;

/** The largest upload accepted: under S3's 5 GB single-upload limit and repack's 10 GB of disk. */
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;

/** The most an upload may unpack to: room for it on a server's 10 GiB data volume. */
export const MAX_UNPACKED_BYTES = 8 * 1024 ** 3;

/** The most files and folders an upload may hold. */
export const MAX_UPLOAD_ENTRIES = 200_000;

/** `GET /admin/uploads/{id}`: how repack is getting on with an upload. */
export type UploadStatus =
  | { uploadId: string; status: 'repacking' }
  | { uploadId: string; status: 'accepted'; bytes: number }
  | { uploadId: string; status: 'rejected'; reason: string };

/** What repack writes to `rejected/<uploadId>.json`. */
export interface Rejection {
  reason: string;
  at: string; // ISO 8601 UTC
}

/** Where the client uploads to. The game is part of the key, so the signed form fixes it. */
export function landingKey(game: GameId, uploadId: string): string {
  return `landing/${game}/${uploadId}`;
}

/** The game and upload ID from a landing key, or undefined if it isn't one. */
export function parseLandingKey(key: string): { game: string; uploadId: string } | undefined {
  const match = /^landing\/([a-z0-9-]+)\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(key);
  return match ? { game: match[1]!, uploadId: match[2]! } : undefined;
}

/** Whether `id` looks like an upload ID (a ULID), so it's safe to put in a key. */
export function isUploadId(id: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id);
}

export function acceptedKey(uploadId: string): string {
  return `accepted/${uploadId}.tar.gz`;
}

export function rejectedKey(uploadId: string): string {
  return `rejected/${uploadId}.json`;
}
