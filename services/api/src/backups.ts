import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { backupPrefix, isBackupKey, type BackupSummary, type BackupTarget } from '@hearth/shared';

/** The backup bucket, as the agent and user routes see it. */
export interface BackupStorage {
  /** Where to upload `key`, with credentials that can write that one key and nothing else. */
  target(serverId: string, key: string): Promise<BackupTarget>;
  /** A short-lived link that downloads `key` and nothing else. It doesn't check `key` exists. */
  downloadUrl(key: string): Promise<string>;
  /** The size of the object at `key`, or undefined if there isn't one. */
  size(key: string): Promise<number | undefined>;
  /** A server's backups, newest first. */
  list(serverId: string): Promise<BackupSummary[]>;
  /** Deletes all but the newest `keep` of a server's backups; returns the deleted keys. */
  prune(serverId: string, keep: number): Promise<string[]>;
}

// The shortest session STS allows; the agent's whole stop takes less than 5 minutes.
const CREDENTIALS_SECONDS = 900;
// The agent downloads right after fetching its config.
const DOWNLOAD_SECONDS = 900;

/**
 * Credentials come from the backup writer role, narrowed by a session policy to one key, so an
 * instance can't touch any other server's backups (or its own older ones).
 */
export function s3BackupStorage(opts: {
  bucket: string;
  region: string;
  writerRoleArn: string;
  sts?: Pick<STSClient, 'send'>;
  s3?: Pick<S3Client, 'send'>;
  presign?: (key: string) => Promise<string>;
}): BackupStorage {
  const { bucket, region, writerRoleArn } = opts;
  const sts = opts.sts ?? new STSClient({});
  const client = new S3Client({ region });
  const s3 = opts.s3 ?? client;
  // Signed with the caller's (the config Lambda's) role, which may read server backups.
  const presign =
    opts.presign ??
    ((key: string) => getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: DOWNLOAD_SECONDS }));

  async function list(serverId: string): Promise<BackupSummary[]> {
    const backups: BackupSummary[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: backupPrefix(serverId), ContinuationToken: token }),
      );
      for (const { Key, LastModified, Size } of page.Contents ?? []) {
        if (!Key || !isBackupKey(serverId, Key)) continue;
        backups.push({ key: Key, takenAt: LastModified?.toISOString() ?? '', bytes: Size ?? 0 });
      }
      token = page.NextContinuationToken;
    } while (token);
    // Keys are named by time, so reverse key order is newest first.
    return backups.sort((a, b) => b.key.localeCompare(a.key));
  }

  return {
    async target(serverId, key) {
      const { Credentials: creds } = await sts.send(
        new AssumeRoleCommand({
          RoleArn: writerRoleArn,
          RoleSessionName: `backup-${serverId}`,
          DurationSeconds: CREDENTIALS_SECONDS,
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:PutObject', 's3:AbortMultipartUpload'],
                Resource: `arn:aws:s3:::${bucket}/${key}`,
              },
            ],
          }),
        }),
      );
      if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken || !creds.Expiration) {
        throw new Error('AssumeRole returned no credentials');
      }
      return {
        bucket,
        key,
        region,
        credentials: {
          accessKeyId: creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken: creds.SessionToken,
          expiration: creds.Expiration.toISOString(),
        },
      };
    },

    downloadUrl: presign,

    async size(key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return out.ContentLength;
      } catch (err) {
        if (err instanceof NotFound) return undefined;
        throw err;
      }
    },

    list,

    async prune(serverId, keep) {
      // The bucket is versioned: a delete hides the object, and the hidden copy expires after 30 days.
      const old = (await list(serverId)).slice(keep).map((b) => b.key);
      if (old.length === 0) return [];
      const out = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: old.map((Key) => ({ Key })), Quiet: true } }),
      );
      if (out.Errors?.length) {
        throw new Error(`Deleting old backups failed: ${out.Errors.map((e) => `${e.Key} ${e.Code}`).join(', ')}`);
      }
      return old;
    },
  };
}
