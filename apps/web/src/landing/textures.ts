// The landing scene's textures: 16×16 pixel art, generated here (no image files, no Mojang art),
// packed into one atlas: the blocks, the plants (see-through), the window and the friend's skin
// (an original character, not Steve). Pure data (RGBA bytes), so it's tested without a browser; the
// renderer uploads it with crisp (nearest) filtering, as Minecraft draws its blocks.
import { seeded } from './random';

/** Pixels per texture side, as in the game. */
export const TILE = 16;
/** Each texture sits in a cell twice its size, its edge pixels repeated into the margin, so
 *  blocks seen from afar (smaller mipmaps) don't pick up their neighbours' colours. */
const CELL = TILE * 2;
const PAD = (CELL - TILE) / 2;
/** Atlas size in cells (power-of-two pixels, for mipmaps). */
const COLS = 8;
const ROWS = 8;
export const ATLAS_WIDTH = COLS * CELL;
export const ATLAS_HEIGHT = ROWS * CELL;

export const TEXTURES = [
  'grassTop', 'grassSide', 'dirt', 'stone', 'stoneDark', 'cobble', 'planks', 'roof',
  'logSide', 'logEnd', 'leaves', 'path', 'obsidian', 'gold', 'slateTop', 'slateSide',
  'duskTop', 'duskSide', 'laterDirt', 'laterStone', 'beacon',
  // Plants: drawn on crossed see-through planes.
  'tallGrass', 'poppy', 'dandelion',
  // The cottage window, and the friend's skin.
  'window', 'face', 'hairTop', 'hairSide', 'hairBack', 'tunic', 'tunicBack', 'trousers', 'sleeve',
  'faceMoss', 'hairTopMoss', 'hairSideMoss', 'hairBackMoss', 'tunicMoss', 'tunicBackMoss', 'trousersMoss', 'sleeveMoss',
] as const;
export type TextureId = (typeof TEXTURES)[number];

/** Every kind of block in the scene, and the texture on each of its faces. */
export const BLOCKS = {
  grass: { top: 'grassTop', side: 'grassSide', bottom: 'dirt' },
  dirt: { top: 'dirt', side: 'dirt', bottom: 'dirt' },
  stone: { top: 'stone', side: 'stone', bottom: 'stone' },
  stoneDark: { top: 'stoneDark', side: 'stoneDark', bottom: 'stoneDark' },
  cobble: { top: 'cobble', side: 'cobble', bottom: 'cobble' },
  planks: { top: 'planks', side: 'planks', bottom: 'planks' },
  roof: { top: 'roof', side: 'roof', bottom: 'roof' },
  log: { top: 'logEnd', side: 'logSide', bottom: 'logEnd' },
  leaves: { top: 'leaves', side: 'leaves', bottom: 'leaves' },
  path: { top: 'path', side: 'dirt', bottom: 'dirt' },
  obsidian: { top: 'obsidian', side: 'obsidian', bottom: 'obsidian' },
  gold: { top: 'gold', side: 'gold', bottom: 'gold' },
  slate: { top: 'slateTop', side: 'slateSide', bottom: 'laterDirt' },
  dusk: { top: 'duskTop', side: 'duskSide', bottom: 'laterDirt' },
  laterDirt: { top: 'laterDirt', side: 'laterDirt', bottom: 'laterDirt' },
  laterStone: { top: 'laterStone', side: 'laterStone', bottom: 'laterStone' },
  beacon: { top: 'beacon', side: 'beacon', bottom: 'beacon' },
} as const satisfies Record<string, { top: TextureId; side: TextureId; bottom: TextureId }>;
export type BlockId = keyof typeof BLOCKS;

type Rgb = readonly [number, number, number];
const rgb = (hex: number): Rgb => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
const scale = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/** Draws one 16×16 texture: pixel (x, y) from the top-left; null leaves it see-through. */
type Painter = (x: number, y: number, rand: () => number) => Rgb | null;

/** A base colour with per-pixel speckle, and a few darker or lighter flecks. */
const speckled = (hex: number, spread = 0.12, flecks?: { hex: number; chance: number }) => (_x: number, _y: number, rand: () => number): Rgb => {
  if (flecks && rand() < flecks.chance) return rgb(flecks.hex);
  return scale(rgb(hex), 1 + (rand() - 0.5) * 2 * spread);
};

/** A top colour that hangs a ragged 3–5 pixels down a side (grass over dirt). */
const capped = (top: (x: number, y: number, rand: () => number) => Rgb, below: (x: number, y: number, rand: () => number) => Rgb, seed: number): Painter => {
  const drop = Array.from({ length: TILE }, (_, x) => 3 + Math.floor(seeded(seed + x)() * 2.4));
  return (x, y, rand) => (y < drop[x]! ? top(x, y, rand) : below(x, y, rand));
};

/** Boards four pixels tall with dark seams, ends staggered, and a little grain. */
const boards = (hex: number, seam: number): Painter => (x, y, rand) => {
  const row = Math.floor(y / 4);
  if (y % 4 === 3) return rgb(seam);
  const end = (row * 7 + 3) % TILE; // where this board meets the next
  if (x === end) return scale(rgb(seam), 1.15);
  return scale(rgb(hex), 0.94 + rand() * 0.1 - (y % 4 === 0 ? 0.05 : 0));
};

/** Irregular stones with dark mortar between them. */
const cobbled = (stone: number, mortar: number): Painter => {
  const r = seeded(41);
  const centres = Array.from({ length: 9 }, () => [r() * TILE, r() * TILE, 0.85 + r() * 0.3] as const);
  return (x, y, rand) => {
    // Distance to the nearest and second-nearest stone centre (wrapping), Voronoi-style.
    let a = Infinity, b = Infinity, k = 1;
    for (const [cx, cy, shade] of centres) {
      const dx = Math.min(Math.abs(x - cx), TILE - Math.abs(x - cx));
      const dy = Math.min(Math.abs(y - cy), TILE - Math.abs(y - cy));
      const d = Math.hypot(dx, dy);
      if (d < a) { b = a; a = d; k = shade; } else if (d < b) b = d;
    }
    if (b - a < 1.1) return scale(rgb(mortar), 0.9 + rand() * 0.2);
    return scale(rgb(stone), k * (0.94 + rand() * 0.12));
  };
};

/** Grass blades: thin strokes of different heights, see-through between them. */
const tallGrass: Painter = (() => {
  const r = seeded(77);
  const blades = Array.from({ length: TILE }, (_, x) => (x % 2 === 0 || r() < 0.4 ? 4 + Math.floor(r() * 9) : 0));
  return (x, y, rand) => (blades[x]! > 0 && y >= TILE - blades[x]! ? scale(rgb(0x5d9b47), 0.8 + rand() * 0.35 + (y < TILE - blades[x]! + 2 ? 0.15 : 0)) : null);
})();

/** A flower: a stem with two leaves, and a head of petals. */
const flower = (petal: number, centre: number, headRows: readonly [number, number]): Painter => (x, y, rand) => {
  const [top, bottom] = headRows;
  if (y >= top && y <= bottom && Math.abs(x - 7.5) <= 2.5 - Math.abs(y - (top + bottom) / 2) * 0.6) {
    return Math.abs(x - 7.5) < 1 && Math.abs(y - (top + bottom) / 2) < 1 ? rgb(centre) : scale(rgb(petal), 0.9 + rand() * 0.2);
  }
  if (y > bottom && (x === 7 || x === 8)) return scale(rgb(0x3f7d3a), 0.9 + rand() * 0.2);
  if (y === 11 && (x === 6 || x === 9)) return rgb(0x4a8a3c);
  return null;
};

/** A window: a plank frame, a cross of glazing bars, warm glass with a highlight. */
const windowPane: Painter = (x, y, rand) => {
  if (x <= 1 || y <= 1 || x >= TILE - 2 || y >= TILE - 2) return scale(rgb(0x6e4a2a), 0.92 + rand() * 0.12);
  if (x === 7 || x === 8 || y === 7 || y === 8) return rgb(0x5a3d24);
  if ((x + y) % 9 === 0 && x < 7 && y < 7) return rgb(0xfff3c4); // a glint
  return scale(rgb(0xffc76b), 0.92 + rand() * 0.1);
};

// The players' skins (original characters, not Steve or Alex): one painter set per palette.
interface Palette {
  hair: number;
  skin: number;
  tunic: number;
  scarf: number;
  trousers: number;
  boots: number;
}
/** Ember: dark hair, warm skin, a slate tunic, an ember scarf. */
const EMBER: Palette = { hair: 0x3b2a1e, skin: 0xd8a77f, tunic: 0x4b5a78, scarf: 0xff8a3d, trousers: 0x2c3344, boots: 0x3b2a1e };
/** Moss: ginger hair, freckled skin, a forest-green tunic, a gold scarf. */
const MOSS: Palette = { hair: 0xa5532a, skin: 0xc58c64, tunic: 0x3f6b45, scarf: 0xe0b33c, trousers: 0x4a3a2a, boots: 0x2a2018 };

function skin(p: Palette) {
  const face: Painter = (x, y, rand) => {
    if (y < 4 || (y < 6 && (x < 2 || x > 13))) return scale(rgb(p.hair), 0.9 + rand() * 0.2); // fringe
    if (y === 7 && ((x >= 3 && x <= 5) || (x >= 10 && x <= 12))) return scale(rgb(p.hair), 0.55); // brows
    if (y === 8 || y === 9) {
      if (x === 4 || x === 11) return rgb(0x23304a); // pupils
      if (x === 3 || x === 5 || x === 10 || x === 12) return rgb(0xf4efe6); // whites
    }
    if (y === 11 && (x === 7 || x === 8)) return scale(rgb(p.skin), 0.82); // nose
    if (y === 13 && x >= 6 && x <= 9) return scale(rgb(p.skin), 0.7); // mouth
    return scale(rgb(p.skin), 0.96 + rand() * 0.06);
  };
  const hairSide: Painter = (_x, y, rand) => (y < 9 ? scale(rgb(p.hair), 0.9 + rand() * 0.2) : scale(rgb(p.skin), 0.94 + rand() * 0.06));
  const tunic = (front: boolean): Painter => (x, y, rand) => {
    if (y < 4) return scale(rgb(p.scarf), 0.92 + rand() * 0.14 - (y === 3 ? 0.12 : 0)); // the scarf
    if (front && y < 9 && (x === 9 || x === 10)) return scale(rgb(p.scarf), 0.85); // its tail
    if (front && y === 12 && x === 7) return rgb(0xc9a14a); // buckle
    if (y === 12) return rgb(0x2a2018); // belt
    return scale(rgb(p.tunic), 0.92 + rand() * 0.14);
  };
  return {
    face,
    hairTop: speckled(p.hair, 0.18),
    hairSide,
    hairBack: speckled(p.hair, 0.18),
    tunic: tunic(true),
    tunicBack: tunic(false),
    trousers: ((_x, y, rand) => scale(rgb(y >= 11 ? p.boots : p.trousers), 0.92 + rand() * 0.14)) as Painter,
    sleeve: ((_x, y, rand) => (y < 6 ? scale(rgb(p.tunic), 0.92 + rand() * 0.14) : scale(rgb(p.skin), 0.95 + rand() * 0.06))) as Painter,
  };
}
const ember = skin(EMBER);
const moss = skin(MOSS);

const PAINTERS: Record<TextureId, Painter> = {
  grassTop: speckled(0x5d9b47, 0.14, { hex: 0x4a8238, chance: 0.12 }),
  grassSide: capped(speckled(0x5d9b47, 0.12), speckled(0x7a5233, 0.12, { hex: 0x5e3e25, chance: 0.1 }), 3),
  dirt: speckled(0x7a5233, 0.12, { hex: 0x5e3e25, chance: 0.12 }),
  stone: speckled(0x7c8085, 0.1, { hex: 0x62666b, chance: 0.15 }),
  stoneDark: speckled(0x55595f, 0.1, { hex: 0x44474c, chance: 0.15 }),
  cobble: cobbled(0x8a8d93, 0x4c4f55),
  planks: boards(0xa8784a, 0x6e4a2a),
  roof: boards(0x6b4a2e, 0x3e2a18),
  logSide: (x, _y, rand) => scale(rgb(x % 4 === 1 ? 0x3f2a17 : 0x5a3d24), 0.92 + rand() * 0.16),
  logEnd: (x, y, rand) => {
    if (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) return scale(rgb(0x5a3d24), 0.9 + rand() * 0.15); // bark rim
    const ring = Math.floor(Math.hypot(x - 7.5, y - 7.5)) % 3 === 0;
    return scale(rgb(ring ? 0x8a5f38 : 0xa8784a), 0.94 + rand() * 0.1);
  },
  leaves: speckled(0x3f7d3a, 0.16, { hex: 0x24481f, chance: 0.22 }),
  path: speckled(0x8b7a5a, 0.1, { hex: 0x6f6046, chance: 0.18 }),
  obsidian: speckled(0x1d1428, 0.25, { hex: 0x3d2a5c, chance: 0.12 }),
  gold: (x, y, rand) => {
    // A bevelled block: a bright rim top and left, a shadow bottom and right, a soft sheen inside.
    if (x === 0 || y === 0) return rgb(0xfff1a8);
    if (x === TILE - 1 || y === TILE - 1) return rgb(0xb8860b);
    if (x === 1 || y === 1) return rgb(0xffe27a);
    if (x === TILE - 2 || y === TILE - 2) return rgb(0xd9a41c);
    const sheen = (x + y) % 7 === 0 ? 1.08 : 1;
    return scale(rgb(0xf0c33c), sheen * (0.97 + rand() * 0.06));
  },
  slateTop: speckled(0x3d4a5a, 0.14),
  slateSide: capped(speckled(0x3d4a5a, 0.12), speckled(0x2c313c, 0.12), 5),
  duskTop: speckled(0x4a3f5c, 0.14),
  duskSide: capped(speckled(0x4a3f5c, 0.12), speckled(0x2c313c, 0.12), 7),
  laterDirt: speckled(0x2c313c, 0.12),
  laterStone: speckled(0x23272f, 0.12),
  beacon: cobbled(0x56607a, 0x2f3442),
  tallGrass,
  poppy: flower(0xd8312b, 0x3a1a12, [3, 7]),
  dandelion: flower(0xf6d33c, 0xe0a414, [5, 8]),
  window: windowPane,
  ...ember,
  faceMoss: moss.face,
  hairTopMoss: moss.hairTop,
  hairSideMoss: moss.hairSide,
  hairBackMoss: moss.hairBack,
  tunicMoss: moss.tunic,
  tunicBackMoss: moss.tunicBack,
  trousersMoss: moss.trousers,
  sleeveMoss: moss.sleeve,
};

/** Each player's textures, by skin. */
export const SKINS = {
  ember: { face: 'face', hairTop: 'hairTop', hairSide: 'hairSide', hairBack: 'hairBack', tunic: 'tunic', tunicBack: 'tunicBack', trousers: 'trousers', sleeve: 'sleeve' },
  moss: { face: 'faceMoss', hairTop: 'hairTopMoss', hairSide: 'hairSideMoss', hairBack: 'hairBackMoss', tunic: 'tunicMoss', tunicBack: 'tunicBackMoss', trousers: 'trousersMoss', sleeve: 'sleeveMoss' },
} as const satisfies Record<string, Record<string, TextureId>>;
export type SkinId = keyof typeof SKINS;

export interface Atlas {
  width: number;
  height: number;
  /** RGBA, row 0 at the top. */
  data: Uint8Array;
}

/** Paints every texture into one atlas. The same pixels every time (seeded per texture). */
export function buildAtlas(): Atlas {
  const data = new Uint8Array(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  TEXTURES.forEach((id, index) => {
    const rand = seeded(1000 + index);
    const painted: (Rgb | null)[] = [];
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) painted.push(PAINTERS[id](x, y, rand));
    // See-through pixels take the average colour of the rest, so smoothed far-off mipmaps don't
    // fringe dark round leaves and petals.
    const solid = painted.filter((p): p is Rgb => p !== null);
    const average: Rgb = solid.length
      ? [0, 1, 2].map((c) => solid.reduce((sum, p) => sum + p[c]!, 0) / solid.length) as unknown as Rgb
      : [0, 0, 0];
    const cx = (index % COLS) * CELL;
    const cy = Math.floor(index / COLS) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        // The margin repeats the texture's nearest edge pixel.
        const tx = Math.min(TILE - 1, Math.max(0, x - PAD));
        const ty = Math.min(TILE - 1, Math.max(0, y - PAD));
        const p = painted[ty * TILE + tx]!;
        const [r, g, b] = p ?? average;
        const i = ((cy + y) * ATLAS_WIDTH + cx + x) * 4;
        data[i] = Math.max(0, Math.min(255, Math.round(r)));
        data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
        data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
        data[i + 3] = p ? 255 : 0;
      }
    }
  });
  return { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, data };
}

/** Textures with see-through pixels: drawn with alpha testing. */
export const SEE_THROUGH: readonly TextureId[] = ['tallGrass', 'poppy', 'dandelion'];

/** Where a texture sits in the atlas, in texture coordinates (0–1; v from the top row up). */
export function uvRect(id: TextureId): { u0: number; v0: number; u1: number; v1: number } {
  const index = TEXTURES.indexOf(id);
  const x = (index % COLS) * CELL + PAD;
  const y = Math.floor(index / COLS) * CELL + PAD;
  // The atlas is uploaded top row first (flipY off), so v grows downward in pixels.
  return { u0: x / ATLAS_WIDTH, u1: (x + TILE) / ATLAS_WIDTH, v0: y / ATLAS_HEIGHT, v1: (y + TILE) / ATLAS_HEIGHT };
}
