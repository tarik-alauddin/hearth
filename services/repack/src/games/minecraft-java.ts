import { globs, type UploadRules } from '../rules.js';

// A Minecraft: Java Edition world: the folder holding level.dat (a single-player save, or the
// world folder from a server). On the server it becomes world/, the image's default level name.

const LEVEL = 'level.dat';

/** World files only: no jars, scripts or anything else a zip might carry along. */
const KEEP = globs([
  'level.dat',
  'level.dat_old',
  'icon.png',
  'region/*.mca',
  'entities/*.mca',
  'poi/*.mca',
  'data/**',
  'playerdata/*.dat',
  'playerdata/*.dat_old',
  'advancements/*.json',
  'stats/*.json',
  // The Nether and the End, in the older and newer layouts.
  'DIM-1/**',
  'DIM1/**',
  'dimensions/**',
  // Data packs change recipes, loot and functions inside the game; they can't run anything outside it.
  'datapacks/**',
]);

export const minecraftJava: UploadRules = {
  findDataRoot(files) {
    const roots = files.filter((f) => f === LEVEL || f.endsWith(`/${LEVEL}`)).map((f) => f.slice(0, -LEVEL.length));
    if (roots.length === 0) return undefined;
    // The shallowest level.dat is the world; a deeper one (a backup kept inside it) is just a file.
    const depth = (root: string) => root.split('/').length;
    const shallowest = Math.min(...roots.map(depth));
    const top = roots.filter((r) => depth(r) === shallowest);
    return top.length === 1 ? top[0] : undefined;
  },
  missingReason: 'no Minecraft world found: the upload needs exactly one folder holding level.dat',
  keep: KEEP,
  destination: 'world/',
  owner: { uid: 1000, gid: 1000 }, // the itzg/minecraft-server image's user
};
