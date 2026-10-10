import { describe, expect, it } from 'vitest';
import { buildWorld, COLORS, shade } from './world';

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
    expect(at(x, 1, z)?.color).toBe(COLORS.obsidian);
    for (const y of [2, 3, 4, 5]) expect(at(x, y, z)?.color).toBe(shade(COLORS.gold, (y - 3.5) * 0.02));
    expect(at(x, 6, z)).toBeUndefined();
  });

  it('leaves the cottage a door and a window', () => {
    expect(at(world.window.x, world.window.y, world.window.z)).toBeUndefined();
    expect(world.torches).toHaveLength(4);
  });

  it('shades colours within range', () => {
    expect(shade(0xffffff, 0.5)).toBe(0xffffff);
    expect(shade(0x000000, -0.5)).toBe(0x000000);
    expect(shade(0x808080, 0.1)).toBe(0x9a9a9a);
  });
});
