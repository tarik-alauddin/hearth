import { describe, expect, it } from 'vitest';
import { ATLAS_HEIGHT, ATLAS_WIDTH, BLOCKS, buildAtlas, SEE_THROUGH, TEXTURES, TILE, uvRect } from './textures';

const atlas = buildAtlas();
/** The pixel at (x, y) inside a texture, as [r, g, b, a]. */
function pixel(id: (typeof TEXTURES)[number], x: number, y: number) {
  const { u0, v0 } = uvRect(id);
  const px = Math.round(u0 * ATLAS_WIDTH) + x;
  const py = Math.round(v0 * ATLAS_HEIGHT) + y;
  const i = (py * ATLAS_WIDTH + px) * 4;
  return [...atlas.data.slice(i, i + 4)];
}

describe('textures', () => {
  it('paints the same atlas every time, in power-of-two size, every texture fully opaque', () => {
    expect(buildAtlas().data).toEqual(atlas.data);
    expect(atlas.data.length).toBe(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
    expect(Math.log2(ATLAS_WIDTH) % 1).toBe(0);
    expect(Math.log2(ATLAS_HEIGHT) % 1).toBe(0);
    for (const id of TEXTURES.filter((t) => !SEE_THROUGH.includes(t))) {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) expect(pixel(id, x, y)[3]).toBe(255);
    }
  });

  it('leaves plants see-through between their blades and petals', () => {
    for (const id of SEE_THROUGH) {
      const alphas = Array.from({ length: TILE * TILE }, (_, i) => pixel(id, i % TILE, Math.floor(i / TILE))[3]);
      expect(alphas).toContain(0);
      expect(alphas).toContain(255);
    }
    expect(pixel('poppy', 0, 0)[3]).toBe(0); // a corner, away from the flower
  });

  it("gives the friend a face: eyes with pupils, on skin under a fringe", () => {
    const [rHair, gHair, bHair] = pixel('face', 8, 1);
    const [rSkin] = pixel('face', 8, 6);
    const [rPupil, , bPupil] = pixel('face', 4, 8);
    expect(rSkin!).toBeGreaterThan(rHair!); // skin is lighter than the hair above it
    expect(rHair! + gHair! + bHair!).toBeLessThan(300);
    expect(bPupil!).toBeGreaterThan(rPupil!); // a blue-grey pupil
  });

  it('places every texture inside the atlas, 16 pixels square, none overlapping', () => {
    const seen = new Set<string>();
    for (const id of TEXTURES) {
      const r = uvRect(id);
      expect((r.u1 - r.u0) * ATLAS_WIDTH).toBeCloseTo(TILE);
      expect((r.v1 - r.v0) * ATLAS_HEIGHT).toBeCloseTo(TILE);
      expect(r.u0).toBeGreaterThan(0);
      expect(r.u1).toBeLessThan(1);
      expect(r.v1).toBeLessThan(1);
      seen.add(`${r.u0},${r.v0}`);
    }
    expect(seen.size).toBe(TEXTURES.length);
  });

  it('gives every block a texture for each face', () => {
    for (const faces of Object.values(BLOCKS)) {
      for (const id of [faces.top, faces.side, faces.bottom]) expect(TEXTURES).toContain(id);
    }
  });

  it('bevels the gold block: a bright rim top-left, a shadow bottom-right', () => {
    const [r1, g1] = pixel('gold', 0, 5);
    const [r2, g2] = pixel('gold', TILE - 1, 5);
    expect(r1! + g1!).toBeGreaterThan(r2! + g2!);
  });

  it('puts green over dirt on the grass side', () => {
    const [, gTop, bTop] = pixel('grassSide', 8, 0);
    const [rLow, gLow] = pixel('grassSide', 8, TILE - 1);
    expect(gTop!).toBeGreaterThan(bTop!); // green
    expect(rLow!).toBeGreaterThan(gLow!); // brown
  });

  it("repeats each texture's edge into its margin, so distant blocks don't bleed", () => {
    const { u0, v0 } = uvRect('gold');
    const x = Math.round(u0 * ATLAS_WIDTH), y = Math.round(v0 * ATLAS_HEIGHT);
    const at = (px: number, py: number) => [...atlas.data.slice((py * ATLAS_WIDTH + px) * 4, (py * ATLAS_WIDTH + px) * 4 + 4)];
    expect(at(x - 3, y + 5)).toEqual(at(x, y + 5));
    expect(at(x + TILE + 2, y + 5)).toEqual(at(x + TILE - 1, y + 5));
  });
});
