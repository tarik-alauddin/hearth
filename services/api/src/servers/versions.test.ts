import { describe, expect, it } from 'vitest';
import { publishedVersions } from './versions.js';

// The manifest's shape, newest first as Mojang lists it, with a snapshot and an old beta mixed in.
const manifest = {
  latest: { release: '26.3', snapshot: '26.4-snapshot-2' },
  versions: [
    { id: '26.4-snapshot-2', type: 'snapshot', releaseTime: '2026-09-29T11:32:57+00:00' },
    { id: '26.3', type: 'release', releaseTime: '2026-09-01T10:00:00+00:00' },
    { id: '26.1', type: 'release', releaseTime: '2026-03-01T10:00:00+00:00' },
    { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T10:12:57+00:00' },
    { id: 'b1.7.3', type: 'old_beta', releaseTime: '2011-07-08T00:00:00+00:00' },
  ],
};

describe('publishedVersions', () => {
  it("lists Minecraft's releases oldest first, without snapshots or betas", async () => {
    const versions = publishedVersions({ fetchJson: async () => manifest });
    expect(await versions.releases('minecraft-java')).toEqual(['1.21.4', '26.1', '26.3']);
  });

  it('caches the list for a few minutes', async () => {
    let fetches = 0;
    let clock = 0;
    const versions = publishedVersions({ fetchJson: async () => (fetches++, manifest), now: () => clock, ttlMs: 1000 });
    await versions.releases('minecraft-java');
    clock = 999;
    await versions.releases('minecraft-java');
    expect(fetches).toBe(1);
    clock = 1000;
    await versions.releases('minecraft-java');
    expect(fetches).toBe(2);
  });
});
