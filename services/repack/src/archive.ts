import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { MAX_UNPACKED_BYTES, MAX_UPLOAD_ENTRIES } from '@hearth/shared';
import { extract } from 'tar-stream';
import yauzl from 'yauzl';

/** A reason to refuse an upload, shown to the person who uploaded it. */
export class Refused extends Error {}

export interface Entry {
  /** Relative, with forward slashes; a directory's ends in "/". */
  path: string;
  dir: boolean;
  /** Uncompressed bytes (0 for a directory). */
  size: number;
  mtime: Date;
}

/** An uploaded archive, read in two passes: list everything, then copy what's wanted. */
export interface Archive {
  /** Every entry, checked: safe relative paths, files and folders only, within the limits. */
  entries(): Promise<Entry[]>;
  /** Streams each wanted file's contents to `sink`, one at a time, in archive order. */
  copy(want: (entry: Entry) => boolean, sink: (entry: Entry, data: Readable) => Promise<void>): Promise<void>;
  close(): void;
}

/** Opens a zip or a gzipped tar, told apart by their first bytes, not their name. */
export async function openArchive(file: string): Promise<Archive> {
  const head = Buffer.alloc(4);
  const handle = await open(file);
  try {
    await handle.read(head, 0, 4, 0);
  } finally {
    await handle.close();
  }
  if (head.readUInt32LE(0) === 0x04034b50) return openZip(file); // "PK\3\4"
  if (head[0] === 0x1f && head[1] === 0x8b) return tarGz(file);
  throw new Refused('the upload must be a .zip or .tar.gz file');
}

/**
 * A safe relative path with forward slashes, or a Refused. Windows tools sometimes write
 * backslashes; absolute paths, drive letters and ".." could land outside the destination.
 */
export function safePath(name: string): string {
  const path = name.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const segments = path.split('/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || segments.includes('..') || path.includes('\0')) {
    throw new Refused(`the upload contains an unsafe path: ${JSON.stringify(name)}`);
  }
  return path;
}

/** Applies the entry-count and total-size limits as entries are listed. */
function limiter() {
  let count = 0;
  let bytes = 0;
  return (entry: Entry) => {
    count += 1;
    bytes += entry.size;
    if (count > MAX_UPLOAD_ENTRIES) throw new Refused(`the upload has more than ${MAX_UPLOAD_ENTRIES} files and folders`);
    if (bytes > MAX_UNPACKED_BYTES) throw new Refused(`the upload unpacks to more than ${MAX_UNPACKED_BYTES / 1024 ** 3} GiB`);
  };
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

async function openZip(file: string): Promise<Archive> {
  // validateEntrySizes: yauzl checks each file's real size against the one the zip claims, so a
  // zip can't pass the size limit and then unpack to far more.
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, z) =>
      err ? reject(new Refused(`the zip can't be read: ${err.message}`)) : resolve(z),
    ),
  );
  const raw: { entry: Entry; zipEntry: yauzl.Entry }[] = [];

  async function list(): Promise<Entry[]> {
    if (raw.length) return raw.map((r) => r.entry);
    const limit = limiter();
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (zipEntry: yauzl.Entry) => {
        try {
          const mode = zipEntry.externalFileAttributes >>> 16;
          if ((mode & S_IFMT) === S_IFLNK) throw new Refused(`the upload contains a link: ${zipEntry.fileName}`);
          const path = safePath(zipEntry.fileName);
          const dir = path.endsWith('/');
          const entry = { path, dir, size: dir ? 0 : zipEntry.uncompressedSize, mtime: zipEntry.getLastModDate() };
          limit(entry);
          raw.push({ entry, zipEntry });
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.on('end', resolve);
      zip.on('error', (err: Error) => reject(new Refused(`the zip can't be read: ${err.message}`)));
      zip.readEntry();
    });
    return raw.map((r) => r.entry);
  }

  return {
    entries: list,
    async copy(want, sink) {
      for (const { entry, zipEntry } of raw) {
        if (entry.dir || !want(entry)) continue;
        const data = await new Promise<Readable>((resolve, reject) =>
          zip.openReadStream(zipEntry, (err, stream) => (err ? reject(new Refused(`the zip can't be read: ${err.message}`)) : resolve(stream))),
        );
        await sink(entry, data);
      }
    },
    close: () => zip.close(),
  };
}

function tarGz(file: string): Archive {
  /** One pass over the archive; `onEntry` must consume or skip each file's stream. */
  async function walk(onEntry: (entry: Entry, data: Readable) => Promise<void>): Promise<void> {
    const tar = extract();
    tar.on('entry', (header, stream, next) => {
      void (async () => {
        if (header.type !== 'file' && header.type !== 'directory') {
          throw new Refused(`the upload contains something other than files and folders: ${header.name}`);
        }
        const path = safePath(header.name);
        const dir = header.type === 'directory';
        const entry = {
          path: dir && !path.endsWith('/') ? `${path}/` : path,
          dir,
          size: dir ? 0 : (header.size ?? 0),
          mtime: header.mtime ?? new Date(0),
        };
        // tar-stream's entry streams (streamx) work as Node readables: pipeline, resume, 'end'.
        await onEntry(entry, stream as unknown as Readable);
      })().then(
        () => next(),
        (err: unknown) => tar.destroy(err as Error),
      );
    });
    try {
      await pipeline(createReadStream(file), createGunzip(), tar);
    } catch (err) {
      throw err instanceof Refused ? err : new Refused(`the .tar.gz can't be read: ${(err as Error).message}`);
    }
  }

  let listed: Entry[] | undefined;
  return {
    async entries() {
      if (listed) return listed;
      const limit = limiter();
      const all: Entry[] = [];
      await walk(async (entry, data) => {
        limit(entry);
        all.push(entry);
        data.resume();
        await new Promise((resolve) => data.on('end', resolve));
      });
      return (listed = all);
    },
    async copy(want, sink) {
      await walk(async (entry, data) => {
        if (!entry.dir && want(entry)) return sink(entry, data);
        data.resume();
        await new Promise((resolve) => data.on('end', resolve));
      });
    },
    close: () => {},
  };
}
