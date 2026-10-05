// World backups in the backup bucket: one gzipped tar per backup, under each server's own prefix.

/** How many backups each server keeps; older ones are deleted when a new one is recorded. */
export const BACKUPS_KEPT = 10;

/** Each environment's backup bucket, in its home region. */
export const backupBucket = (env: string, account: string, region: string) => `hearth-${env}-backups-${account}-${region}`;

/** Every backup of a server is under this prefix; credentials and retention are scoped to it. */
export function backupPrefix(serverId: string): string {
  return `servers/${serverId}/`;
}

/** The key for a backup taken at `at`, e.g. `servers/01J.../20261004T153000Z.tar.gz`. Keys sort by time. */
export function backupKey(serverId: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `${backupPrefix(serverId)}${stamp}.tar.gz`;
}

/** Whether `key` is one of this server's backups, in the format `backupKey` makes. */
export function isBackupKey(serverId: string, key: string): boolean {
  const prefix = backupPrefix(serverId);
  return key.startsWith(prefix) && /^\d{8}T\d{6}Z\.tar\.gz$/.test(key.slice(prefix.length));
}
