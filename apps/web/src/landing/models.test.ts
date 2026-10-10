import { describe, expect, it } from 'vitest';
import { allFaces, buildPlants, texturedBox } from './models';
import { uvRect } from './textures';
import { buildWorld } from './world';

describe('models', () => {
  it('draws each plant as two crossed planes', () => {
    const plants = buildPlants({ voxels: [], lights: [], plants: [{ x: 0, y: 1, z: 0, kind: 'poppy' }] });
    expect(plants.positions.length).toBe(2 * 4 * 3);
    expect(plants.indices.length).toBe(2 * 6);
    // Standing on the block below: the planes start at its top (y 0.5).
    expect(Math.min(...plants.positions.filter((_, i) => i % 3 === 1))).toBe(0.5);
  });

  it('lights plants by the light where they stand', () => {
    const plant = { x: 0, y: 1, z: 0, kind: 'tallGrass' as const };
    const dark = buildPlants({ voxels: [], lights: [], plants: [plant] });
    const lit = buildPlants({ voxels: [], lights: [{ x: 0, y: 1, z: 1, level: 15 }], plants: [plant] });
    expect(lit.colors[0]!).toBeGreaterThan(dark.colors[0]!);
  });

  it('puts a texture on each face of a box, front facing +z', () => {
    const box = texturedBox([0, 0, 0], [1, 1, 1], { ...allFaces('trousers'), front: 'face' });
    expect(box.positions.length).toBe(6 * 4 * 3);
    // The front face (first) sits at z = +0.5 and shows the face texture.
    expect([0, 1, 2, 3].map((c) => box.positions[c * 3 + 2])).toEqual([0.5, 0.5, 0.5, 0.5]);
    const us = [0, 1, 2, 3].map((c) => box.uvs[c * 2]!);
    expect(Math.min(...us)).toBe(uvRect('face').u0);
    expect(Math.max(...us)).toBe(uvRect('face').u1);
  });
});

describe('the landing world: plants', () => {
  const world = buildWorld();

  it('grows flowers and tall grass on the open grass of the Minecraft island', () => {
    expect(world.plants.length).toBeGreaterThan(10);
    expect(new Set(world.plants.map((p) => p.kind))).toEqual(new Set(['tallGrass', 'poppy', 'dandelion']));
    const blocks = new Map(world.voxels.map((v) => [`${v.x},${v.y},${v.z}`, v.block]));
    for (const p of world.plants) {
      expect(blocks.get(`${p.x},${p.y - 1},${p.z}`)).toBe('grass'); // on grass
      expect(blocks.has(`${p.x},${p.y},${p.z}`)).toBe(false); // in the open
    }
  });

  it("keeps plants out of the cottage and off the torches, the players and the tower", () => {
    const { cottage, torches, pimps, players } = world;
    for (const p of world.plants) {
      expect(Math.abs(p.x - cottage.x) <= 2 && Math.abs(p.z - cottage.z) <= 2).toBe(false);
      for (const spot of [...torches, pimps, ...players.map((pl) => ({ x: Math.round(pl.x), z: Math.round(pl.z) }))]) {
        expect(p.x === spot.x && p.z === spot.z).toBe(false);
      }
    }
  });
});
