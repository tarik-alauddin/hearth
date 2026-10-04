import { HeadObjectCommand, NotFound } from '@aws-sdk/client-s3';
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
});
