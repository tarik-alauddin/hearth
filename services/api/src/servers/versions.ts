import type { GameId } from '@hearth/shared';

/** Each game's full releases, from its publisher; set-version only moves between these. */
export interface GameVersions {
  /** Release versions, oldest first, or undefined if Hearth has no version list for the game. */
  releases(game: GameId): Promise<string[] | undefined>;
}

const MINECRAFT_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

interface MinecraftManifest {
  versions: { id: string; type: string; releaseTime: string }[];
}

/**
 * Version lists fetched from each publisher, cached for a few minutes: releases are rare, and
 * Mojang's manifest is a few hundred KB.
 */
export function publishedVersions(
  opts: { fetchJson?: (url: string) => Promise<unknown>; now?: () => number; ttlMs?: number } = {},
): GameVersions {
  const { fetchJson = defaultFetchJson, now = Date.now, ttlMs = 10 * 60_000 } = opts;
  const cache = new Map<GameId, { at: number; releases: string[] }>();

  async function minecraftReleases(): Promise<string[]> {
    const manifest = (await fetchJson(MINECRAFT_MANIFEST)) as MinecraftManifest;
    // Ordered by release date: version numbers alone don't sort (1.21.4 came before 26.1).
    return manifest.versions
      .filter((v) => v.type === 'release')
      .sort((a, b) => a.releaseTime.localeCompare(b.releaseTime))
      .map((v) => v.id);
  }

  return {
    async releases(game) {
      if (game !== 'minecraft-java') return undefined;
      const hit = cache.get(game);
      if (hit && now() - hit.at < ttlMs) return hit.releases;
      const releases = await minecraftReleases();
      cache.set(game, { at: now(), releases });
      return releases;
    },
  };
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}
