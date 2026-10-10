// Turns the landing world's blocks into lit surfaces, the way Minecraft draws its world: only the
// faces that touch air, each corner coloured by the light around it. Pure data in, arrays out (no
// rendering), so it's tested without a browser.
//
// - Block light: each source has a level (15 brightest); it spreads through air, one level dimmer
//   per block, so torches throw pools of warm light that fade over a dozen blocks.
// - Smooth lighting: a corner's light is the average of the (up to) four air cells around it.
// - Ambient occlusion: corners tucked against other blocks are darker, so shapes read at a glance.
// - Face shading: tops brightest, sides less, bottoms least (fixed, as in the game).
// - Night: a dim, cool moonlight everywhere, so nothing is ever black; the block light is warm.
// Colours here are light only: each face's texture (textures.ts) gives the block its colour.
import { BLOCKS, uvRect } from './textures';
import type { World } from './world';

export interface Surfaces {
  /** x, y, z per vertex. */
  positions: Float32Array;
  /** Linear r, g, b per vertex: the light falling there (the texture is multiplied by it). */
  colors: Float32Array;
  /** u, v per vertex: the face's texture in the atlas. */
  uvs: Float32Array;
  /** Two triangles per face. */
  indices: Uint32Array;
  /** How many faces were kept (the rest touch other blocks and can't be seen). */
  faces: number;
}

/** Moonlight: the least any face gets (0–1) and its tint. */
export const MOON = { level: 0.3, tint: [0.62, 0.7, 1.0] } as const;
/** Torch and fire light's tint, at full strength. */
export const WARM = [1.25, 0.86, 0.52] as const;
/** Darkening per number of blocks crowding a corner (0 = open … 3 = tucked in). */
export const AO = [1, 0.82, 0.68, 0.52] as const;

/**
 * The six faces: normal, the two in-face axes, the fixed shade, which of the block's textures it
 * shows, and whether the texture's up runs along `u` (east and west, whose `u` is y): side
 * textures always stand upright.
 */
const FACES = [
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 1.0, tex: 'top', upAlongU: false },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.5, tex: 'bottom', upAlongU: false },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8, tex: 'side', upAlongU: false }, // south
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.8, tex: 'side', upAlongU: false }, // north
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.62, tex: 'side', upAlongU: true }, // east
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.62, tex: 'side', upAlongU: true }, // west
] as const;

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** The light colour (linear r, g, b) for a block-light level (0–1) on a surface of the given shade. */
export function lightRgb(level: number, dim = 1): [number, number, number] {
  const warm = level ** 1.5; // fades faster near its edge, like the game
  return [0, 1, 2].map((i) => dim * Math.min(1.6, MOON.level * MOON.tint[i]! + warm * WARM[i]!)) as [number, number, number];
}

/** Block light through air: each source's level, minus one per block of air travelled. */
export function spreadLight(world: Pick<World, 'voxels' | 'lights'>): Map<string, number> {
  const solid = new Set(world.voxels.map((v) => key(v.x, v.y, v.z)));
  const light = new Map<string, number>();
  const queue: [number, number, number, number][] = [];
  for (const l of world.lights) {
    if (solid.has(key(l.x, l.y, l.z))) continue;
    light.set(key(l.x, l.y, l.z), l.level);
    queue.push([l.x, l.y, l.z, l.level]);
  }
  for (let head = 0; head < queue.length; head++) {
    const [x, y, z, level] = queue[head]!;
    if (level <= 1) continue;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const k = key(x + dx, y + dy, z + dz);
      if (solid.has(k) || (light.get(k) ?? 0) >= level - 1) continue;
      light.set(k, level - 1);
      queue.push([x + dx, y + dy, z + dz, level - 1]);
    }
  }
  return light;
}

/** `moonOnly`: no block light (the scene before its torches are lit). */
export function buildSurfaces(world: Pick<World, 'voxels' | 'lights'>, { moonOnly = false } = {}): Surfaces {
  const solid = new Set(world.voxels.map((v) => key(v.x, v.y, v.z)));
  const isSolid = (x: number, y: number, z: number) => solid.has(key(x, y, z));
  const light = moonOnly ? new Map<string, number>() : spreadLight(world);
  const lightAt = (x: number, y: number, z: number) => (light.get(key(x, y, z)) ?? 0) / 15;

  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let faces = 0;

  for (const block of world.voxels) {
    for (const { n, u, v, shade, tex, upAlongU } of FACES) {
      // The air cell the face looks into; a face against another block is never seen.
      const ax = block.x + n[0], ay = block.y + n[1], az = block.z + n[2];
      if (isSolid(ax, ay, az)) continue;
      const first = positions.length / 3;
      faces++;
      const rect = uvRect(BLOCKS[block.block][tex]);
      // Corners in order round the face: (−u −v), (+u −v), (+u +v), (−u +v).
      const aos: number[] = [];
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        positions.push(
          block.x + 0.5 * n[0] + 0.5 * su * u[0] + 0.5 * sv * v[0],
          block.y + 0.5 * n[1] + 0.5 * su * u[1] + 0.5 * sv * v[1],
          block.z + 0.5 * n[2] + 0.5 * su * u[2] + 0.5 * sv * v[2],
        );
        // Texture across (−1 left … +1 right) and up (−1 bottom … +1 top); the atlas's v runs down.
        const [across, up] = upAlongU ? [sv, su] : [su, sv];
        uvs.push(across < 0 ? rect.u0 : rect.u1, up > 0 ? rect.v0 : rect.v1);
        // The three cells beside the corner, in front of the face.
        const side1 = [ax + su * u[0], ay + su * u[1], az + su * u[2]] as const;
        const side2 = [ax + sv * v[0], ay + sv * v[1], az + sv * v[2]] as const;
        const corner = [ax + su * u[0] + sv * v[0], ay + su * u[1] + sv * v[1], az + su * u[2] + sv * v[2]] as const;
        const s1 = isSolid(...side1), s2 = isSolid(...side2), c = isSolid(...corner);
        const crowd = s1 && s2 ? 3 : Number(s1) + Number(s2) + Number(c);
        aos.push(crowd);
        // Smooth light: the average over the open cells round the corner.
        const open = [[ax, ay, az] as const, ...(s1 ? [] : [side1]), ...(s2 ? [] : [side2]), ...(c || (s1 && s2) ? [] : [corner])];
        const level = open.reduce((sum, cell) => sum + lightAt(...cell), 0) / open.length;
        colors.push(...lightRgb(level, shade * AO[crowd]!));
      }
      // Split the quad along the brighter diagonal, so shading doesn't crease (as Minecraft does).
      if (aos[0]! + aos[2]! > aos[1]! + aos[3]!) indices.push(first + 1, first + 2, first + 3, first + 1, first + 3, first);
      else indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      // Faces wind counter-clockwise seen from outside: flip those whose axes run the other way.
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]] as const;
      if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) {
        const tri = indices.splice(indices.length - 6, 6);
        indices.push(tri[0]!, tri[2]!, tri[1]!, tri[3]!, tri[5]!, tri[4]!);
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    faces,
  };
}
