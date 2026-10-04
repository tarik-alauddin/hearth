import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { BackupTarget } from '@hearth/shared';

/** The backup bucket, as the agent routes see it. */
export interface BackupStorage {
  /** Where to upload `key`, with credentials that can write that one key and nothing else. */
  target(serverId: string, key: string): Promise<BackupTarget>;
  /** The size of the object at `key`, or undefined if there isn't one. */
  size(key: string): Promise<number | undefined>;
}

// The shortest session STS allows; the agent's whole stop takes less than 5 minutes.
const CREDENTIALS_SECONDS = 900;

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
}): BackupStorage {
  const { bucket, region, writerRoleArn } = opts;
  const sts = opts.sts ?? new STSClient({});
  const s3 = opts.s3 ?? new S3Client({ region });

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

    async size(key) {
      try {
        const out = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return out.ContentLength;
      } catch (err) {
        if (err instanceof NotFound) return undefined;
        throw err;
      }
    },
  };
}
