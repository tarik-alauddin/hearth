// Small textured shapes for the landing scene, beside the blocks (surfaces.ts): the plants (two
// crossed see-through planes each, as in the game), and boxes with a texture per face (the friend,
// the window). Pure data, like the surfaces, so they're tested without a browser.
import { lightRgb, spreadLight } from './surfaces';
import { uvRect, type TextureId } from './textures';
import type { World } from './world';

export interface Shape {
  positions: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

const empty = (): Shape => ({ positions: [], uvs: [], colors: [], indices: [] });

/** Adds a quad: four corners (counter-clockwise from the front), the texture, the light colour. */
function quad(shape: Shape, corners: readonly (readonly [number, number, number])[], tex: TextureId, rgb: readonly number[]) {
  const first = shape.positions.length / 3;
  const r = uvRect(tex);
  // Bottom-left, bottom-right, top-right, top-left; the atlas's v runs down.
  const uv = [[r.u0, r.v1], [r.u1, r.v1], [r.u1, r.v0], [r.u0, r.v0]] as const;
  corners.forEach((c, i) => {
    shape.positions.push(...c);
    shape.uvs.push(...uv[i]!);
    shape.colors.push(...rgb);
  });
  shape.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

/** Every plant, lit by the light where it stands (block light from spreadLight). */
export function buildPlants(world: Pick<World, 'voxels' | 'lights' | 'plants'>): Shape {
  const light = spreadLight(world);
  const shape = empty();
  for (const p of world.plants) {
    const rgb = lightRgb((light.get(`${p.x},${p.y},${p.z}`) ?? 0) / 15, 0.95);
    const s = p.kind === 'tallGrass' ? 0.45 : 0.32; // flowers are smaller than grass
    const y0 = p.y - 0.5, y1 = p.y - 0.5 + s * 2;
    for (const [dx, dz] of [[1, 1], [1, -1]] as const) {
      quad(shape, [[p.x - s * dx, y0, p.z - s * dz], [p.x + s * dx, y0, p.z + s * dz], [p.x + s * dx, y1, p.z + s * dz], [p.x - s * dx, y1, p.z - s * dz]], p.kind, rgb);
    }
  }
  return shape;
}

export interface BoxFaces {
  front: TextureId; // +z
  back: TextureId;
  left: TextureId; // −x
  right: TextureId;
  top: TextureId;
  bottom: TextureId;
}

/**
 * A box centred on (x, y, z), sized w × h × d, a texture on each face, all faces the same light
 * (`rgb`) with the game's fixed face shading on top. Its front faces +z.
 */
export function texturedBox(
  [x, y, z]: readonly [number, number, number],
  [w, h, d]: readonly [number, number, number],
  faces: BoxFaces,
  rgb: readonly number[] = [1, 1, 1],
): Shape {
  const shape = empty();
  const [a, b, c] = [w / 2, h / 2, d / 2];
  const lit = (k: number) => rgb.map((v) => v * k);
  // Each face's corners: bottom-left, bottom-right, top-right, top-left, seen from outside.
  quad(shape, [[x - a, y - b, z + c], [x + a, y - b, z + c], [x + a, y + b, z + c], [x - a, y + b, z + c]], faces.front, lit(0.8));
  quad(shape, [[x + a, y - b, z - c], [x - a, y - b, z - c], [x - a, y + b, z - c], [x + a, y + b, z - c]], faces.back, lit(0.8));
  quad(shape, [[x - a, y - b, z - c], [x - a, y - b, z + c], [x - a, y + b, z + c], [x - a, y + b, z - c]], faces.left, lit(0.62));
  quad(shape, [[x + a, y - b, z + c], [x + a, y - b, z - c], [x + a, y + b, z - c], [x + a, y + b, z + c]], faces.right, lit(0.62));
  quad(shape, [[x - a, y + b, z + c], [x + a, y + b, z + c], [x + a, y + b, z - c], [x - a, y + b, z - c]], faces.top, lit(1));
  quad(shape, [[x - a, y - b, z - c], [x + a, y - b, z - c], [x + a, y - b, z + c], [x - a, y - b, z + c]], faces.bottom, lit(0.5));
  return shape;
}

/** The same texture on every face. */
export const allFaces = (tex: TextureId): BoxFaces => ({ front: tex, back: tex, left: tex, right: tex, top: tex, bottom: tex });
