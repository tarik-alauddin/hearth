import { DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, NotFound } from '@aws-sdk/client-s3';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { describe, expect, it } from 'vitest';
import { s3BackupStorage } from './backups.js';

const KEY = 'servers/s1/20261004T120000Z.tar.gz';

describe('s3BackupStorage', () => {
  it('hands out credentials narrowed to the one key', async () => {
    const sent: AssumeRoleCommand[] = [];
    const sts = {
      send: async (command: AssumeRoleCommand) => {
        sent.push(command);
        return {
          Credentials: {
            AccessKeyId: 'AKID',
            SecretAccessKey: 'secret',
            SessionToken: 'token',
            Expiration: new Date('2026-10-04T12:15:00Z'),
          },
        };
      },
    };
    const storage = s3BackupStorage({ bucket: 'b', region: 'us-west-2', writerRoleArn: 'arn:role', sts: sts as never });

    expect(await storage.target('s1', KEY)).toEqual({
      bucket: 'b',
      key: KEY,
      region: 'us-west-2',
      credentials: {
        accessKeyId: 'AKID',
        secretAccessKey: 'secret',
        sessionToken: 'token',
        expiration: '2026-10-04T12:15:00.000Z',
      },
    });
    expect(sent[0]).toBeInstanceOf(AssumeRoleCommand);
    const { RoleArn, RoleSessionName, Policy } = sent[0]!.input;
    expect({ RoleArn, RoleSessionName }).toEqual({ RoleArn: 'arn:role', RoleSessionName: 'backup-s1' });
    expect(JSON.parse(Policy!).Statement).toEqual([
      { Effect: 'Allow', Action: ['s3:PutObject', 's3:AbortMultipartUpload'], Resource: `arn:aws:s3:::b/${KEY}` },
    ]);
  });

  it("reads an object's size, or undefined when it doesn't exist", async () => {
    const s3 = {
      send: async (command: HeadObjectCommand) => {
        if (command.input.Key === KEY) return { ContentLength: 42 };
        throw new NotFound({ message: 'not found', $metadata: {} });
      },
    };
    const storage = s3BackupStorage({ bucket: 'b', region: 'us-west-2', writerRoleArn: 'arn:role', s3: s3 as never });
    expect(await storage.size(KEY)).toBe(42);
    expect(await storage.size('servers/s1/missing.tar.gz')).toBeUndefined();
  });

  describe('prune', () => {
    const key = (i: number) => `servers/s1/202610${String(i).padStart(2, '0')}T120000Z.tar.gz`;

    /** A bucket listing `keys` under servers/s1/ in pages of `pageSize`, recording deletes. */
    function bucket(keys: string[], pageSize = 1000) {
      const deleted: string[][] = [];
      const prefixes: string[] = [];
      const s3 = {
        send: async (command: ListObjectsV2Command | DeleteObjectsCommand) => {
          if (command instanceof ListObjectsV2Command) {
            prefixes.push(command.input.Prefix!);
            const start = Number(command.input.ContinuationToken ?? 0);
            const end = start + pageSize;
            return {
              Contents: keys.slice(start, end).map((Key) => ({ Key })),
              NextContinuationToken: end < keys.length ? String(end) : undefined,
            };
          }
          deleted.push(command.input.Delete!.Objects!.map((o) => o.Key!));
          return {};
        },
      };
      const storage = s3BackupStorage({ bucket: 'b', region: 'us-west-2', writerRoleArn: 'arn:role', s3: s3 as never });
      return { storage, deleted, prefixes };
    }

    it('deletes all but the newest, across listing pages', async () => {
      // Listed out of order, with something that isn't a backup.
      const keys = [key(3), key(12), key(1), 'servers/s1/notes.txt', key(2), ...[4, 5, 6, 7, 8, 9, 10, 11].map(key)];
      const { storage, deleted, prefixes } = bucket(keys, 5);
      expect(await storage.prune('s1', 10)).toEqual([key(1), key(2)]);
      expect(deleted).toEqual([[key(1), key(2)]]);
      expect(prefixes.every((p) => p === 'servers/s1/')).toBe(true);
    });

    it('deletes nothing when there are 10 or fewer', async () => {
      const { storage, deleted } = bucket([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(key));
      expect(await storage.prune('s1', 10)).toEqual([]);
      expect(deleted).toEqual([]);
    });

    it('fails when S3 reports a key it could not delete', async () => {
      const s3 = {
        send: async (command: unknown) =>
          command instanceof ListObjectsV2Command
            ? { Contents: [{ Key: key(1) }, { Key: key(2) }] }
            : { Errors: [{ Key: key(1), Code: 'AccessDenied' }] },
      };
      const storage = s3BackupStorage({ bucket: 'b', region: 'us-west-2', writerRoleArn: 'arn:role', s3: s3 as never });
      await expect(storage.prune('s1', 1)).rejects.toThrow(`${key(1)} AccessDenied`);
    });
  });
});
