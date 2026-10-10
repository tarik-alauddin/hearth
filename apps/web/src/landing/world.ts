// The landing scene's world, as plain data: every block of the islands, and where the lit and
// living parts stand. No rendering here, so it's tested without a browser (hearthScene.ts draws it).

/** One block: its position (one unit per block) and colour (sRGB hex). */
export interface Voxel {
  x: number;
  y: number;
  z: number;
  color: number;
}

export interface World {
  voxels: Voxel[];
  /** Torch posts, lit one by one as the page opens. */
  torches: { x: number; z: number }[];
  /** The cottage window, which glows after the torches. */
  window: { x: number; y: number; z: number };
  /** Where the blocky friend stands. */
  friend: { x: number; z: number };
  /** The Tower of Pimps: obsidian at y 1, gold above. */
  pimps: { x: number; z: number };
}

/** Block colours (sRGB). */
export const COLORS = {
  grass: 0x5d9b47,
  dirt: 0x7a5233,
  stone: 0x6c7076,
  hearthTop: 0x5a5e66,
  hearthUnder: 0x4a4d54,
  hearthStone: 0x3d4047,
  ringStone: 0x8a8d93,
  planks: 0xa8784a,
  logs: 0x5a3d24,
  roof: 0x6b4a2e,
  chimney: 0x7d8087,
  leaves: 0x3f7d3a,
  path: 0x8b7a5a,
  obsidian: 0x1d1428,
  gold: 0xf0c33c,
  laterUnder: 0x2c313c,
  laterStone: 0x23272f,
  beacon: 0x56607a,
} as const;

/** Deterministic randomness (mulberry32), so the islands look the same on every load. */
export function seeded(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A colour a little lighter or darker (amount in −1…1 of full brightness), for texture. */
export function shade(color: number, amount: number): number {
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((color >> shift) & 0xff) + amount * 255)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

export function buildWorld(seed = 7): World {
  const rand = seeded(seed);
  // Keyed by position: a later block replaces an earlier one (a path over grass), so no two cubes
  // share a place and flicker.
  const blocks = new Map<string, Voxel>();
  const put = (x: number, y: number, z: number, color: number) => blocks.set(`${x},${y},${z}`, { x, y, z, color });
  const jitter = (color: number, spread: number) => shade(color, (rand() - 0.5) * spread);

  function island(cx: number, cz: number, r: number, top: number, under: number, stone: number) {
    for (let x = -Math.floor(r); x <= r; x++) {
      for (let z = -Math.floor(r); z <= r; z++) {
        const d = Math.hypot(x, z) + rand() * 0.8;
        if (d > r) continue;
        put(cx + x, 0, cz + z, jitter(top, 0.06));
        const depth = 1 + Math.floor((r - d) * 0.9 + rand() * 1.5);
        for (let k = 1; k <= depth; k++) put(cx + x, -k, cz + z, jitter(k > 2 ? stone : under, 0.05));
      }
    }
  }

  // The hearth: a stone island in the middle and a ring of stones round the fire.
  island(0, 0, 3.6, COLORS.hearthTop, COLORS.hearthUnder, COLORS.hearthStone);
  for (const [x, z] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const) {
    put(x, 1, z, jitter(COLORS.ringStone, 0.1));
  }

  // The Minecraft-style island (the one game Hearth hosts today), out in front.
  const mc = { x: 9, z: 6 };
  island(mc.x, mc.z, 5.4, COLORS.grass, COLORS.dirt, COLORS.stone);
  // A cottage: plank walls, a door and a window, a stepped roof, a chimney.
  const cot = { x: mc.x - 1, z: mc.z - 1 };
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 1; y <= 3; y++) {
        if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue;
        const door = z === 2 && x === 0 && y <= 2;
        const window = x === 2 && z === 0 && y === 2;
        if (door || window) continue;
        const corner = Math.abs(x) === 2 && Math.abs(z) === 2;
        put(cot.x + x, y, cot.z + z, corner ? COLORS.logs : jitter(COLORS.planks, 0.05));
      }
    }
  }
  for (let s = 0; s <= 2; s++) {
    for (let x = -3 + s; x <= 3 - s; x++) {
      for (let z = -3; z <= 3; z++) {
        if (s > 0 && Math.abs(z) > 3 - s) continue;
        put(cot.x + x, 4 + s, cot.z + z, jitter(COLORS.roof, 0.06));
      }
    }
  }
  for (const y of [5, 6, 7]) put(cot.x + 2, y, cot.z - 2, COLORS.chimney);
  // A tree beside it.
  const tree = { x: mc.x + 3, z: mc.z - 2 };
  for (let y = 1; y <= 4; y++) put(tree.x, y, tree.z, COLORS.logs);
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 4; y <= 6; y++) {
        if (Math.abs(x) + Math.abs(z) + (y - 4) > 3 + (rand() < 0.3 ? 1 : 0)) continue;
        if (x === 0 && z === 0 && y < 5) continue;
        put(tree.x + x, y, tree.z + z, jitter(COLORS.leaves, 0.1));
      }
    }
  }
  // A short path from the door.
  for (let i = 1; i <= 4; i++) put(cot.x, 0, cot.z + 2 + i, jitter(COLORS.path, 0.05));
  // The Tower of Pimps (Achievement Hunter's): one obsidian block, four gold blocks on top.
  const pimps = { x: mc.x + 3, z: mc.z + 2 };
  put(pimps.x, 1, pimps.z, COLORS.obsidian);
  for (const y of [2, 3, 4, 5]) put(pimps.x, y, pimps.z, shade(COLORS.gold, (y - 3.5) * 0.02));

  // Islands for games still to come: dim, quiet, each with an unlit beacon.
  for (const o of [
    { x: -10, z: 2, r: 3.6, top: 0x3d4a5a },
    { x: -2, z: -11, r: 3.2, top: 0x4a3f5c },
  ]) {
    island(o.x, o.z, o.r, o.top, COLORS.laterUnder, COLORS.laterStone);
    for (let y = 1; y <= 3; y++) put(o.x, y, o.z, shade(COLORS.beacon, -0.05 * y));
  }

  return {
    voxels: [...blocks.values()],
    torches: [
      { x: cot.x - 1, z: cot.z + 3 },
      { x: cot.x + 1, z: cot.z + 3 },
      { x: cot.x - 3, z: cot.z + 1 },
      { x: tree.x - 1, z: tree.z + 2 },
    ],
    window: { x: cot.x + 2, y: 2, z: cot.z },
    friend: { x: cot.x + 0.6, z: cot.z + 4.4 },
    pimps,
  };
}
