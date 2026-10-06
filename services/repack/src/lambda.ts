// Repacks each upload as it lands: S3 "Object Created" events for landing/ arrive through EventBridge.
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { EventBridgeEvent } from 'aws-lambda';
import { MAX_UPLOAD_BYTES, acceptedKey, parseLandingKey, rejectedKey, type GameId, type Rejection } from '@hearth/shared';
import { UPLOAD_RULES } from './games/index.js';
import { repack } from './repack.js';
import type { UploadRules } from './rules.js';

type ObjectCreated = EventBridgeEvent<'Object Created', { bucket: { name: string }; object: { key: string; size?: number } }>;

export interface RepackDeps {
  bucket: string;
  s3: Pick<S3Client, 'send'>;
  rules?: Partial<Record<GameId, UploadRules>>;
  workDir?: string;
  now?: () => Date;
}

/**
 * Handles one landed upload. The result is either `accepted/<id>.tar.gz` or `rejected/<id>.json`;
 * the landing file is left to expire (repack has no delete permission). Running twice for the
 * same upload writes the same result again.
 */
export function repackHandler({ bucket, s3, rules = UPLOAD_RULES, workDir = tmpdir(), now = () => new Date() }: RepackDeps) {
  return async (event: ObjectCreated): Promise<void> => {
    const { key, size } = event.detail.object;
    const landing = parseLandingKey(key);
    if (event.detail.bucket.name !== bucket || !landing) {
      console.warn(JSON.stringify({ msg: 'not an upload; ignored', bucket: event.detail.bucket.name, key }));
      return;
    }
    const { game, uploadId } = landing;

    const reject = async (reason: string) => {
      const body: Rejection = { reason, at: now().toISOString() };
      await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: rejectedKey(uploadId), Body: JSON.stringify(body), ContentType: 'application/json' }),
      );
      console.log(JSON.stringify({ msg: 'upload rejected', uploadId, game, reason }));
    };

    const gameRules = rules[game as GameId];
    if (!gameRules) return reject(`uploads aren't supported for ${game}`);
    if (size !== undefined && size > MAX_UPLOAD_BYTES) return reject('the upload is over the size limit');

    // Lambda keeps /tmp between runs: name files per upload and always clean up.
    const input = join(workDir, `${uploadId}.upload`);
    const output = join(workDir, `${uploadId}.tar.gz`);
    try {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(Body as Readable, createWriteStream(input));

      const outcome = await repack(input, output, gameRules);
      if (!outcome.accepted) return await reject(outcome.reason);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: acceptedKey(uploadId),
          Body: createReadStream(output),
          ContentLength: (await stat(output)).size,
          ContentType: 'application/gzip',
        }),
      );
      console.log(JSON.stringify({ msg: 'upload accepted', uploadId, game, files: outcome.files, bytes: outcome.bytes }));
    } catch (err) {
      // Not the uploader's doing, but they still need an answer: a rejection, not a silent wait.
      console.error(JSON.stringify({ msg: 'repack failed', uploadId, err: String(err) }));
      await reject("the upload couldn't be repacked; try uploading it again");
    } finally {
      await rm(input, { force: true });
      await rm(output, { force: true });
    }
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Built on first use, so importing this module (in tests) needs no environment.
let handle: ReturnType<typeof repackHandler> | undefined;
export const handler = (event: ObjectCreated) =>
  (handle ??= repackHandler({ bucket: requireEnv('UPLOADS_BUCKET'), s3: new S3Client({}) }))(event);
