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

/** Where the client uploads to. The game is part of the key, so the signed form fixes it. */
export function landingKey(game: GameId, uploadId: string): string {
  return `landing/${game}/${uploadId}`;
}

export function acceptedKey(uploadId: string): string {
  return `accepted/${uploadId}.tar.gz`;
}

export function rejectedKey(uploadId: string): string {
  return `rejected/${uploadId}.json`;
}
