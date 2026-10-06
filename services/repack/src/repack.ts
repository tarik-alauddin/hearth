import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { finished, pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack, type Pack } from 'tar-stream';
import { Refused, openArchive, type Entry } from './archive.js';
import type { UploadRules } from './rules.js';

type EntryHeader = Parameters<Pack['entry']>[0];

export type Outcome = { accepted: true; files: number; bytes: number } | { accepted: false; reason: string };

/**
 * Repacks the upload at `input` into `output` in Hearth's backup format (a gzipped tar the agent
 * restores): only the game's data, only allowlisted files, under the game's destination, owned by
 * the game's user. Anything unsafe or unrecognised is refused with a reason for the uploader.
 */
export async function repack(input: string, output: string, rules: UploadRules): Promise<Outcome> {
  let archive;
  try {
    archive = await openArchive(input);
  } catch (err) {
    if (err instanceof Refused) return { accepted: false, reason: err.message };
    throw err;
  }
  try {
    const entries = await archive.entries();
    const root = rules.findDataRoot(entries.filter((e) => !e.dir).map((e) => e.path));
    if (root === undefined) return { accepted: false, reason: rules.missingReason };

    const kept = new Set(
      entries.filter((e) => !e.dir && e.path.startsWith(root) && rules.keep(e.path.slice(root.length))).map((e) => e.path),
    );
    const name = (entry: Entry) => rules.destination + entry.path.slice(root.length);

    const tar = pack();
    const written = createWriteStream(output);
    const done = pipeline(tar, createGzip(), written);
    const header = (h: EntryHeader): EntryHeader => ({ ...h, uid: rules.owner.uid, gid: rules.owner.gid });

    // Folders first, owned by the game's user: the agent creates any folder missing from the
    // archive as root, and the game couldn't write into it.
    for (const dir of folders([...kept].map((path) => name({ path } as Entry)))) {
      tar.entry(header({ name: dir, type: 'directory', mode: 0o755, mtime: new Date() }));
    }
    let files = 0;
    await archive.copy(
      (entry) => kept.has(entry.path),
      async (entry, data) => {
        const sink = tar.entry(header({ name: name(entry), type: 'file', size: entry.size, mode: 0o644, mtime: entry.mtime }));
        await pipeline(data, sink);
        files += 1;
      },
    );
    tar.finalize();
    await done;
    await finished(written);
    return { accepted: true, files, bytes: (await stat(output)).size };
  } catch (err) {
    if (err instanceof Refused) return { accepted: false, reason: err.message };
    throw err;
  } finally {
    archive.close();
  }
}

/** Every folder the files sit in, parents before children ("world/", "world/region/", …). */
export function folders(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...dirs].sort();
}
