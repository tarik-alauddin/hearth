// The landing scene's world, as plain data: every block of the islands, and where the lit and
// living parts stand. No rendering here, so it's tested without a browser (hearthScene.ts draws it).
import { seeded } from './random';
import type { BlockId, SkinId } from './textures';

export { seeded };

/** One block: its position (one unit per block) and kind (its textures, in textures.ts). */
export interface Voxel {
  x: number;
  y: number;
  z: number;
  block: BlockId;
}

export interface World {
  voxels: Voxel[];
  /** Torch posts, lit one by one as the page opens. */
  torches: { x: number; z: number }[];
  /** The cottage window, which glows after the torches. */
  window: { x: number; y: number; z: number };
  /** The players: where each stands, which way they face (radians round y, 0 = +z), their skin,
   *  and what they're doing. */
  players: { x: number; z: number; facing: number; skin: SkinId; pose: 'idle' | 'pointing' }[];
  /** The Tower of Pimps: obsidian at y 1, gold above. */
  pimps: { x: number; z: number };
  /** The cottage's centre (its walls are 5×5) and the top of its chimney, where smoke rises. */
  cottage: { x: number; z: number };
  chimney: { x: number; y: number; z: number };
  /** Flowers and tall grass on the Minecraft island's open grass. */
  plants: { x: number; y: number; z: number; kind: 'tallGrass' | 'poppy' | 'dandelion' }[];
  /** Where light comes from, Minecraft-style: a level (15 brightest) that fades a step per block. */
  lights: { x: number; y: number; z: number; level: number }[];
}

/** Colours (sRGB) of the scene's few moving, non-block parts: the fire's logs and the torch posts. */
export const COLORS = {
  logs: 0x5a3d24,
} as const;

export function buildWorld(seed = 7): World {
  const rand = seeded(seed);
  // Keyed by position: a later block replaces an earlier one (a path over grass), so no two cubes
  // share a place and flicker.
  const blocks = new Map<string, Voxel>();
  const put = (x: number, y: number, z: number, block: BlockId) => blocks.set(`${x},${y},${z}`, { x, y, z, block });

  function island(cx: number, cz: number, r: number, top: BlockId, under: BlockId, stone: BlockId) {
    for (let x = -Math.floor(r); x <= r; x++) {
      for (let z = -Math.floor(r); z <= r; z++) {
        const d = Math.hypot(x, z) + rand() * 0.8;
        if (d > r) continue;
        put(cx + x, 0, cz + z, top);
        const depth = 1 + Math.floor((r - d) * 0.9 + rand() * 1.5);
        for (let k = 1; k <= depth; k++) put(cx + x, -k, cz + z, k > 2 ? stone : under);
      }
    }
  }

  // The hearth: a stone island in the middle and a ring of stones round the fire.
  island(0, 0, 3.6, 'stone', 'stoneDark', 'stoneDark');
  for (const [x, z] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const) {
    put(x, 1, z, 'cobble');
  }

  // The Minecraft-style island (the one game Hearth hosts today), out in front.
  const mc = { x: 9, z: 6 };
  island(mc.x, mc.z, 5.4, 'grass', 'dirt', 'stone');
  // A second lobe under the tree, so it has room round it.
  island(mc.x + 5, mc.z - 3, 2.4, 'grass', 'dirt', 'stone');
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
        put(cot.x + x, y, cot.z + z, corner ? 'log' : 'planks');
      }
    }
  }
  for (let s = 0; s <= 2; s++) {
    for (let x = -3 + s; x <= 3 - s; x++) {
      for (let z = -3; z <= 3; z++) {
        if (s > 0 && Math.abs(z) > 3 - s) continue;
        put(cot.x + x, 4 + s, cot.z + z, 'roof');
      }
    }
  }
  for (const y of [5, 6, 7]) put(cot.x + 2, y, cot.z - 2, 'cobble');
  // A tree beside it, a step clear of the walls (its trunk stands on the island's grass).
  const tree = { x: mc.x + 4, z: mc.z - 2 };
  for (let y = 1; y <= 4; y++) put(tree.x, y, tree.z, 'log');
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      for (let y = 4; y <= 6; y++) {
        if (Math.abs(x) + Math.abs(z) + (y - 4) > 3 + (rand() < 0.3 ? 1 : 0)) continue;
        if (x === 0 && z === 0 && y < 5) continue;
        // Leaves fill the air only: they never replace the roof they reach.
        if (!blocks.has(`${tree.x + x},${y},${tree.z + z}`)) put(tree.x + x, y, tree.z + z, 'leaves');
      }
    }
  }
  // A short path from the door.
  for (let i = 1; i <= 4; i++) put(cot.x, 0, cot.z + 2 + i, 'path');
  // The Tower of Pimps (Achievement Hunter's): one obsidian block, four gold blocks on top.
  const pimps = { x: mc.x + 3, z: mc.z + 2 };
  put(pimps.x, 1, pimps.z, 'obsidian');
  for (const y of [2, 3, 4, 5]) put(pimps.x, y, pimps.z, 'gold');

  // Islands for games still to come: dim, quiet, each with an unlit beacon.
  for (const o of [
    { x: -10, z: 2, r: 3.6, top: 'slate' as const },
    { x: -2, z: -11, r: 3.2, top: 'dusk' as const },
  ]) {
    island(o.x, o.z, o.r, o.top, 'laterDirt', 'laterStone');
    for (let y = 1; y <= 3; y++) put(o.x, y, o.z, 'beacon');
  }

  const torches = [
    { x: cot.x - 1, z: cot.z + 3 },
    { x: cot.x + 1, z: cot.z + 3 },
    { x: cot.x - 3, z: cot.z + 1 },
    { x: tree.x - 1, z: tree.z + 2 },
  ];
  const window = { x: cot.x + 2, y: 2, z: cot.z };
  const players: World['players'] = [
    // On the path by the door, looking round.
    { x: cot.x + 0.6, z: cot.z + 4.4, facing: 0.5, skin: 'ember', pose: 'idle' },
    // Beside the Tower of Pimps, pointing up at it.
    { x: pimps.x - 1, z: pimps.z + 1.2, facing: Math.atan2(1, -1.2), skin: 'moss', pose: 'pointing' },
  ];

  // Plants on open grass: not inside the cottage, nor where a torch, a player or the tower stands.
  const busy = new Set([...torches, pimps, ...players.map((p) => ({ x: Math.round(p.x), z: Math.round(p.z) }))].map((p) => `${p.x},${p.z}`));
  const plants: World['plants'] = [];
  const plantRand = seeded(seed + 101);
  for (const v of [...blocks.values()].sort((a, b) => a.x - b.x || a.z - b.z)) {
    if (v.block !== 'grass' || v.y !== 0 || blocks.has(`${v.x},1,${v.z}`)) continue;
    if (Math.abs(v.x - cot.x) <= 2 && Math.abs(v.z - cot.z) <= 2) continue;
    if (busy.has(`${v.x},${v.z}`)) continue;
    const roll = plantRand();
    if (roll > 0.42) continue;
    plants.push({ x: v.x, y: 1, z: v.z, kind: roll < 0.06 ? 'poppy' : roll < 0.11 ? 'dandelion' : 'tallGrass' });
  }

  return {
    voxels: [...blocks.values()],
    torches,
    window,
    players,
    pimps,
    cottage: cot,
    chimney: { x: cot.x + 2, y: 7, z: cot.z - 2 },
    plants,
    lights: [
      { x: 0, y: 1, z: 0, level: 15 }, // the hearth's fire
      ...torches.map((t) => ({ x: t.x, y: 2, z: t.z, level: 14 })),
      { x: cot.x, y: 2, z: cot.z, level: 13 }, // a lamp inside the cottage, showing through the window and door
    ],
  };
}
