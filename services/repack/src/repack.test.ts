import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { extract, pack } from 'tar-stream';
import { beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { safePath } from './archive.js';
import { minecraftJava } from './games/minecraft-java.js';
import { repackHandler } from './lambda.js';
import { folders, repack } from './repack.js';
import { globs } from './rules.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'repack-'));
});

type Item = { name: string; data?: string; mode?: number };

async function zip(items: Item[]): Promise<string> {
  const file = join(dir, `in-${Math.random()}.zip`);
  const z = new yazl.ZipFile();
  for (const { name, data = 'x', mode } of items) {
    if (name.endsWith('/')) z.addEmptyDirectory(name);
    else z.addBuffer(Buffer.from(data), name, mode ? { mode } : {});
  }
  z.end();
  await pipeline(z.outputStream, createWriteStream(file));
  return file;
}

async function tarGz(items: (Item & { type?: 'file' | 'symlink'; linkname?: string })[]): Promise<string> {
  const file = join(dir, `in-${Math.random()}.tar.gz`);
  const p = pack();
  for (const { name, data = 'x', type = 'file', linkname } of items) {
    if (type === 'symlink') p.entry({ name, type, linkname });
    else p.entry({ name, size: Buffer.byteLength(data) }, data);
  }
  p.finalize();
  await pipeline(p, createGzip(), createWriteStream(file));
  return file;
}

type Out = { name: string; type: string; uid?: number; gid?: number; mode?: number; data: string };

async function read(file: string): Promise<Out[]> {
  const out: Out[] = [];
  const x = extract();
  x.on('entry', (h, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => {
      out.push({ name: h.name, type: h.type ?? 'file', uid: h.uid, gid: h.gid, mode: h.mode, data: Buffer.concat(chunks).toString() });
      next();
    });
  });
  await pipeline(createReadStream(file), createGunzip(), x);
  return out;
}

const SAVE: Item[] = [
  { name: 'MyWorld/level.dat', data: 'level' },
  { name: 'MyWorld/region/r.0.0.mca', data: 'region' },
  { name: 'MyWorld/DIM-1/region/r.0.0.mca', data: 'nether' },
  { name: 'MyWorld/playerdata/abc.dat' },
  { name: 'MyWorld/session.lock' },
  { name: 'MyWorld/mods/evil.jar' },
  { name: 'MyWorld/run.sh' },
  { name: 'readme.txt' },
  { name: '__MACOSX/MyWorld/._level.dat' },
];

describe('repack', () => {
  it.each([
    ['a zip', zip],
    ['a .tar.gz', tarGz],
  ])("keeps only the game's data from %s, under its destination, owned by the game's user", async (_, make) => {
    const output = join(dir, 'out.tar.gz');
    const outcome = await repack(await make(SAVE), output, minecraftJava);
    expect(outcome).toMatchObject({ accepted: true, files: 4 });

    const entries = await read(output);
    expect(entries.map((e) => e.name)).toEqual([
      'world/',
      'world/DIM-1/',
      'world/DIM-1/region/',
      'world/playerdata/',
      'world/region/',
      'world/level.dat',
      'world/region/r.0.0.mca',
      'world/DIM-1/region/r.0.0.mca',
      'world/playerdata/abc.dat',
    ]);
    expect(entries.find((e) => e.name === 'world/level.dat')?.data).toBe('level');
    expect(entries.every((e) => e.uid === 1000 && e.gid === 1000)).toBe(true);
    expect(entries.filter((e) => e.type === 'directory').every((e) => e.mode === 0o755)).toBe(true);
    expect(entries.filter((e) => e.type === 'file').every((e) => e.mode === 0o644)).toBe(true);
  });

  it('takes a world at the top level of the upload', async () => {
    const output = join(dir, 'out.tar.gz');
    await repack(await zip([{ name: 'level.dat' }, { name: 'region/r.0.0.mca' }]), output, minecraftJava);
    expect((await read(output)).map((e) => e.name)).toEqual(['world/', 'world/region/', 'world/level.dat', 'world/region/r.0.0.mca']);
  });

  it.each([
    ['no world', [{ name: 'notes/readme.txt' }], /no Minecraft world found/],
    ['two worlds side by side', [{ name: 'A/level.dat' }, { name: 'B/level.dat' }], /no Minecraft world found/],
    ['a link', [{ name: 'MyWorld/level.dat' }, { name: 'MyWorld/escape', mode: 0o120777 }], /contains a link/],
  ])('refuses a zip with %s', async (_, items, reason) => {
    const outcome = await repack(await zip(items), join(dir, 'out.tar.gz'), minecraftJava);
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted === false && outcome.reason).toMatch(reason);
  });

  it.each([
    ['a path out of the upload', [{ name: '../evil', data: 'x' }], /unsafe path/],
    ['an absolute path', [{ name: '/etc/evil' }], /unsafe path/],
    ['a symlink', [{ name: 'level.dat' }, { name: 'out', type: 'symlink' as const, linkname: '/etc' }], /other than files and folders/],
  ])('refuses a .tar.gz with %s', async (_, items, reason) => {
    const outcome = await repack(await tarGz(items), join(dir, 'out.tar.gz'), minecraftJava);
    expect(outcome.accepted === false && outcome.reason).toMatch(reason);
  });

  it('refuses something that is neither a zip nor a .tar.gz, whatever it is called', async () => {
    const file = join(dir, 'world.zip');
    await writeFile(file, '<html>not a zip</html>');
    const outcome = await repack(file, join(dir, 'out.tar.gz'), minecraftJava);
    expect(outcome.accepted === false && outcome.reason).toMatch(/must be a .zip or .tar.gz/);
  });

  it('refuses a corrupt zip', async () => {
    const file = join(dir, 'broken.zip');
    await writeFile(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]));
    const outcome = await repack(file, join(dir, 'out.tar.gz'), minecraftJava);
    expect(outcome.accepted === false && outcome.reason).toMatch(/can't be read/);
  });
});

describe('safePath', () => {
  it.each([
    ['world\\region\\r.0.0.mca', 'world/region/r.0.0.mca'],
    ['./level.dat', 'level.dat'],
  ])('normalises %s', (name, want) => {
    expect(safePath(name)).toBe(want);
  });

  it.each(['../x', 'a/../../x', '/etc/passwd', 'C:\\Windows\\x', 'C:x', 'a\\..\\..\\x', 'a\0b'])('refuses %s', (name) => {
    expect(() => safePath(name)).toThrow(/unsafe path/);
  });
});

describe('folders', () => {
  it('lists every parent folder once, parents first', () => {
    expect(folders(['world/level.dat', 'world/region/a.mca', 'world/region/b.mca'])).toEqual(['world/', 'world/region/']);
  });
});

describe('globs', () => {
  const match = globs(['level.dat', 'region/*.mca', 'data/**']);
  it.each([
    ['level.dat', true],
    ['region/r.0.0.mca', true],
    ['region/sub/r.0.0.mca', false],
    ['data/raids.dat', true],
    ['data/a/b/c.dat', true],
    ['levelXdat', false],
    ['mods/x.jar', false],
  ])('%s → %s', (path, want) => {
    expect(match(path)).toBe(want);
  });
});

describe('minecraft-java findDataRoot', () => {
  it.each([
    [['level.dat', 'region/a.mca'], ''],
    [['MyWorld/level.dat'], 'MyWorld/'],
    [['MyWorld/level.dat', 'MyWorld/backup/level.dat'], 'MyWorld/'],
    [['A/level.dat', 'B/level.dat'], undefined],
    [['A/level.dat_old'], undefined],
  ])('%j → %j', (files, want) => {
    expect(minecraftJava.findDataRoot(files)).toBe(want);
  });
});

describe('repackHandler', () => {
  const UPLOAD = '01K6ABCDEF0123456789ABCDEF';
  const event = (key: string, bucket = 'uploads') =>
    ({ detail: { bucket: { name: bucket }, object: { key, size: 100 } } }) as Parameters<ReturnType<typeof repackHandler>>[0];

  function fakeS3(upload?: string) {
    const puts: { key: string; body: string }[] = [];
    const s3 = {
      send: async (command: GetObjectCommand | PutObjectCommand) => {
        if (command instanceof GetObjectCommand) {
          if (!upload) throw new Error('S3 unavailable');
          return { Body: createReadStream(upload) };
        }
        const body = command.input.Body;
        puts.push({ key: command.input.Key!, body: typeof body === 'string' ? body : '<file>' });
        if (typeof body !== 'string') (body as Readable).resume();
        return {};
      },
    };
    return { s3: s3 as never, puts };
  }

  it('writes the accepted archive and leaves no files behind', async () => {
    const { s3, puts } = fakeS3(await zip(SAVE));
    const work = await mkdtemp(join(tmpdir(), 'work-'));
    await repackHandler({ bucket: 'uploads', s3, workDir: work })(event(`landing/minecraft-java/${UPLOAD}`));
    expect(puts.map((p) => p.key)).toEqual([`accepted/${UPLOAD}.tar.gz`]);
    expect(await readdir(work)).toEqual([]);
  });

  it('writes a rejection with the reason', async () => {
    const { s3, puts } = fakeS3(await zip([{ name: 'notes.txt' }]));
    await repackHandler({ bucket: 'uploads', s3, workDir: dir, now: () => new Date('2026-10-05T12:00:00Z') })(
      event(`landing/minecraft-java/${UPLOAD}`),
    );
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`rejected/${UPLOAD}.json`);
    expect(JSON.parse(puts[0]!.body)).toEqual({ reason: minecraftJava.missingReason, at: '2026-10-05T12:00:00.000Z' });
  });

  it("rejects a game with no upload rules, and answers even when repack itself fails", async () => {
    const noRules = fakeS3(await zip(SAVE));
    await repackHandler({ bucket: 'uploads', s3: noRules.s3, rules: {}, workDir: dir })(event(`landing/minecraft-java/${UPLOAD}`));
    expect(JSON.parse(noRules.puts[0]!.body).reason).toMatch(/aren't supported/);

    const broken = fakeS3(); // GetObject fails
    await repackHandler({ bucket: 'uploads', s3: broken.s3, workDir: dir })(event(`landing/minecraft-java/${UPLOAD}`));
    expect(JSON.parse(broken.puts[0]!.body).reason).toMatch(/try uploading it again/);
  });

  it('ignores objects that are not uploads, or in another bucket', async () => {
    const { s3, puts } = fakeS3(await zip(SAVE));
    const handle = repackHandler({ bucket: 'uploads', s3, workDir: dir });
    await handle(event(`accepted/${UPLOAD}.tar.gz`));
    await handle(event('landing/minecraft-java/not-an-id'));
    await handle(event(`landing/minecraft-java/${UPLOAD}`, 'someone-elses'));
    expect(puts).toEqual([]);
  });
});
