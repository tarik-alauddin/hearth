import { describe, expect, it } from 'vitest';
import { buildSurfaces, spreadLight } from './surfaces';
import { uvRect } from './textures';
import { buildWorld, type Voxel } from './world';

const block = (x: number, y: number, z: number): Voxel => ({ x, y, z, block: 'stone' });
/** The colours of a face's 4 corners, by the index of its first vertex. */
const corners = (colors: Float32Array, face: number) => [0, 1, 2, 3].map((c) => colors[(face * 4 + c) * 3]!);

describe('surfaces', () => {
  it('draws only the faces that touch air', () => {
    expect(buildSurfaces({ voxels: [block(0, 0, 0)], lights: [] }).faces).toBe(6);
    // Two blocks side by side hide the two faces between them.
    expect(buildSurfaces({ voxels: [block(0, 0, 0), block(1, 0, 0)], lights: [] }).faces).toBe(10);
    const s = buildSurfaces({ voxels: [block(0, 0, 0)], lights: [] });
    expect(s.positions.length).toBe(6 * 4 * 3);
    expect(s.indices.length).toBe(6 * 6);
  });

  it('spreads light through air, one level dimmer per block, and not through blocks', () => {
    const light = spreadLight({ voxels: [block(2, 0, 0)], lights: [{ x: 0, y: 0, z: 0, level: 15 }] });
    expect(light.get('0,0,0')).toBe(15);
    expect(light.get('1,0,0')).toBe(14);
    expect(light.get('0,0,3')).toBe(12);
    expect(light.get('2,0,0')).toBeUndefined(); // the block itself
    expect(light.get('3,0,0')).toBe(10); // round it, not through it: 5 steps
  });

  it('darkens corners crowded by other blocks', () => {
    // A block, then the same with a wall on its east edge: the top face's two east corners darken.
    // (The top face is the first face of the first block; its corners run −x−z, +x−z, +x+z, −x+z.)
    const open = corners(buildSurfaces({ voxels: [block(0, 0, 0)], lights: [] }).colors, 0);
    const walled = corners(buildSurfaces({ voxels: [block(0, 0, 0), block(1, 1, 0)], lights: [] }).colors, 0);
    expect(walled[1]).toBeLessThan(open[1]!);
    expect(walled[2]).toBeLessThan(open[2]!);
    expect(walled[0]).toBe(open[0]);
    expect(walled[3]).toBe(open[3]);
  });

  it('never goes black at night, and warms up near a light', () => {
    const dark = buildSurfaces({ voxels: [block(0, 0, 0)], lights: [] });
    expect(Math.min(...dark.colors)).toBeGreaterThan(0.05);
    const lit = buildSurfaces({ voxels: [block(0, 0, 0)], lights: [{ x: 0, y: 1, z: 0, level: 15 }] });
    // The top face, right under the light: brighter, and warmer (more red than blue).
    const [r, , b] = [lit.colors[0]!, lit.colors[1]!, lit.colors[2]!];
    expect(r).toBeGreaterThan(dark.colors[0]!);
    expect(r).toBeGreaterThan(b);
    expect(dark.colors[0]!).toBeLessThan(dark.colors[2]!); // moonlight is cool
  });

  it('can leave block light out (the scene before its torches light)', () => {
    const world = buildWorld();
    const lit = buildSurfaces(world);
    const moon = buildSurfaces(world, { moonOnly: true });
    expect(moon.faces).toBe(lit.faces);
    expect(moon.colors.reduce((a, b) => a + b, 0)).toBeLessThan(lit.colors.reduce((a, b) => a + b, 0));
  });

  it("maps each face to its block's texture, side textures standing upright", () => {
    const s = buildSurfaces({ voxels: [{ x: 0, y: 0, z: 0, block: 'grass' }], lights: [] });
    expect(s.uvs.length).toBe(6 * 4 * 2);
    const rect = (face: number) => {
      const us = [0, 1, 2, 3].map((c) => s.uvs[(face * 4 + c) * 2]!);
      const vs = [0, 1, 2, 3].map((c) => s.uvs[(face * 4 + c) * 2 + 1]!);
      return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
    };
    expect(rect(0)).toEqual(uvRect('grassTop'));
    expect(rect(1)).toEqual(uvRect('dirt'));
    for (const face of [2, 3, 4, 5]) expect(rect(face)).toEqual(uvRect('grassSide'));
    // On every side, the corners higher up the block take the texture's top row (the smaller v).
    for (const face of [2, 3, 4, 5]) {
      const ys = [0, 1, 2, 3].map((c) => s.positions[(face * 4 + c) * 3 + 1]!);
      const vs = [0, 1, 2, 3].map((c) => s.uvs[(face * 4 + c) * 2 + 1]!);
      for (let c = 0; c < 4; c++) expect(vs[c]).toBe(ys[c]! > 0 ? uvRect('grassSide').v0 : uvRect('grassSide').v1);
    }
  });

  it('builds the whole landing world', () => {
    const s = buildSurfaces(buildWorld());
    expect(s.faces).toBeGreaterThan(500);
    expect(s.colors.every((c) => Number.isFinite(c) && c >= 0)).toBe(true);
  });
});
