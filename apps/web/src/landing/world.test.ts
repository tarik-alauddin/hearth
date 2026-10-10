import { describe, expect, it } from 'vitest';
import { buildWorld } from './world';

describe('the landing world', () => {
  const world = buildWorld();
  const at = (x: number, y: number, z: number) => world.voxels.find((v) => v.x === x && v.y === y && v.z === z);

  it('looks the same on every load', () => {
    expect(buildWorld()).toEqual(world);
  });

  it('never puts two blocks in one place', () => {
    const keys = new Set(world.voxels.map((v) => `${v.x},${v.y},${v.z}`));
    expect(keys.size).toBe(world.voxels.length);
  });

  it('has the Tower of Pimps: one obsidian block, four gold blocks on top', () => {
    const { x, z } = world.pimps;
    expect(at(x, 1, z)?.block).toBe('obsidian');
    for (const y of [2, 3, 4, 5]) expect(at(x, y, z)?.block).toBe('gold');
    expect(at(x, 6, z)).toBeUndefined();
  });

  it('leaves the cottage a door and a window', () => {
    expect(at(world.window.x, world.window.y, world.window.z)).toBeUndefined();
    expect(world.torches).toHaveLength(4);
  });

  it("keeps the tree's leaves out of the cottage's roof", () => {
    const { cottage } = world;
    // The roof spans 7 x 7 at y 4 round the cottage's centre; none of it is leaves.
    for (let x = cottage.x - 3; x <= cottage.x + 3; x++) {
      for (let z = cottage.z - 3; z <= cottage.z + 3; z++) expect(at(x, 4, z)?.block).toBe('roof');
    }
  });

  it('puts two players on solid grass, in different skins, one pointing at the tower', () => {
    expect(world.players).toHaveLength(2);
    expect(new Set(world.players.map((p) => p.skin)).size).toBe(2);
    for (const p of world.players) {
      expect(at(Math.round(p.x), 0, Math.round(p.z))).toBeDefined();
      expect(at(Math.round(p.x), 1, Math.round(p.z))).toBeUndefined();
    }
    const pointing = world.players.find((p) => p.pose === 'pointing')!;
    // Facing the tower: its direction from the player matches their facing.
    const toTower = Math.atan2(world.pimps.x - pointing.x, world.pimps.z - pointing.z);
    expect(toTower).toBeCloseTo(pointing.facing, 5);
  });

  it('gives the tree grass all round it', () => {
    const trunk = world.voxels.find((v) => v.block === 'log' && v.y === 1 && !(Math.abs(v.x - world.cottage.x) <= 2 && Math.abs(v.z - world.cottage.z) <= 2))!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, -2]] as const) {
      expect(at(trunk.x + dx, 0, trunk.z + dz)).toBeDefined();
    }
  });

  it('gives the Minecraft island grass on top and dirt below', () => {
    const top = world.voxels.filter((v) => v.y === 0 && v.x >= 4 && v.z >= 1);
    expect(top.some((v) => v.block === 'grass')).toBe(true);
    expect(world.voxels.some((v) => v.y < 0 && v.block === 'dirt')).toBe(true);
  });
});
