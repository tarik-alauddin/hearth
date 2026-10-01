import { describe, expect, it } from 'vitest';
import { ssmAgentReleases } from './releases.js';

describe('ssmAgentReleases', () => {
  it('turns a channel parameter into a download target', async () => {
    const reads: string[] = [];
    const releases = ssmAgentReleases({
      env: 'dev',
      bucket: 'hearth-agent-releases-1',
      get: async (name) => {
        reads.push(name);
        return '{"version":"1.3.0","sha256":"abc"}';
      },
    });
    expect(await releases.target('canary')).toEqual({
      version: '1.3.0',
      sha256: 'abc',
      url: 's3://hearth-agent-releases-1/agent/1.3.0/hearth-agent-linux-arm64',
    });
    expect(reads).toEqual(['/hearth/dev/agent/canary']);
  });

  it('has no target for a channel that has never been set', async () => {
    const releases = ssmAgentReleases({ env: 'dev', bucket: 'b', get: async () => undefined });
    expect(await releases.target('stable')).toBeUndefined();
  });

  it('caches each channel for a minute', async () => {
    let clock = 0;
    let reads = 0;
    const releases = ssmAgentReleases({
      env: 'dev',
      bucket: 'b',
      now: () => clock,
      get: async () => {
        reads++;
        return '{"version":"1","sha256":"s"}';
      },
    });
    await releases.target('stable');
    clock = 59_000;
    await releases.target('stable');
    expect(reads).toBe(1);
    clock = 61_000;
    await releases.target('stable');
    expect(reads).toBe(2);
  });
});
