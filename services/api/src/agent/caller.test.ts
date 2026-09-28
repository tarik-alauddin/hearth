import { describe, expect, it } from 'vitest';
import { callerInstanceId } from './caller.js';

const ROLES = ['hearth-dev-GameInfra-InstanceRole-abc'];
const arn = (role: string, session: string) => `arn:aws:sts::138300868928:assumed-role/${role}/${session}`;

describe('callerInstanceId', () => {
  it('returns the instance ID for a game instance role session', () => {
    expect(callerInstanceId(arn(ROLES[0]!, 'i-0123456789abcdef0'), ROLES)).toBe('i-0123456789abcdef0');
  });

  it('rejects other roles, even with an instance-like session name', () => {
    expect(callerInstanceId(arn('github-deploy', 'i-0123456789abcdef0'), ROLES)).toBeUndefined();
  });

  it('rejects sessions that are not instance IDs', () => {
    expect(callerInstanceId(arn(ROLES[0]!, 'someone'), ROLES)).toBeUndefined();
  });

  it('rejects IAM users and missing identities', () => {
    expect(callerInstanceId('arn:aws:iam::138300868928:user/admin', ROLES)).toBeUndefined();
    expect(callerInstanceId(undefined, ROLES)).toBeUndefined();
  });
});
