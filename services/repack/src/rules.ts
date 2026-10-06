// What repack needs to know about a game to accept an upload for it. Everything else (reading
// archives safely, limits, writing the result) is game-neutral and lives in repack.ts.

export interface UploadRules {
  /**
   * The folder in the upload that holds the game's data ("" for the top level, else ending in
   * "/"), given every file path in it; undefined rejects the upload (with `missingReason`).
   */
  findDataRoot(files: readonly string[]): string | undefined;
  /** Why `findDataRoot` found nothing, in the game's own terms. */
  missingReason: string;
  /** Whether a file (relative to the data root) is kept. An allowlist: the rest is dropped. */
  keep(path: string): boolean;
  /** Where the kept files go on the server's data volume, ending in "/". */
  destination: string;
  /** Owner of the files on the server: the user the game's container runs as. */
  owner: { uid: number; gid: number };
}

/**
 * A matcher for slash-separated glob patterns: `*` matches within one path segment, `**` any
 * number of whole segments (`a/**` matches everything under `a/`).
 */
export function globs(patterns: readonly string[]): (path: string) => boolean {
  const regexes = patterns.map((pattern) => {
    const source = pattern
      .split('/')
      .map((segment) =>
        segment === '**'
          ? '.*'
          : segment
              .split('*')
              .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
              .join('[^/]*'),
      )
      .join('/');
    return new RegExp(`^${source}$`);
  });
  return (path) => regexes.some((regex) => regex.test(path));
}
