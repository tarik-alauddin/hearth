import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_IDLE_STOP_MINUTES,
  GAME_DEFINITIONS,
  MAX_UPLOAD_BYTES,
  type CreateUploadResponse,
  type FleetReport,
  type ListBackupsResponse,
  type ListServersResponse,
  type RestoreRequest,
  type ServerOperationResult,
  type ServerRecord,
  type ServerStatus,
  type SetVersionRequest,
  type UpdateSettingsRequest,
  type UploadStatus,
} from '@hearth/shared';
import { ApiError, sendUpload as defaultSendUpload, type Api } from './client.js';

async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export interface CommandDeps {
  api: Api;
  /** Runs the fleet check Lambda and returns its report. */
  fleetCheck?: () => Promise<FleetReport>;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often to check progress while waiting, and for how long. */
  pollMs?: number;
  timeoutMs?: number;
  /** Sends a file with an upload form (see client.ts), and reads a file's size. */
  sendUpload?: (form: CreateUploadResponse, file: string) => Promise<void>;
  fileSize?: (file: string) => Promise<number>;
  /** Asks a question on the terminal and returns the answer. */
  ask?: (question: string) => Promise<string>;
}

/** Stop waiting with a non-zero exit; the message says why. */
export class CommandError extends Error {}

export function commands({
  api,
  fleetCheck,
  print,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 5_000,
  timeoutMs = 20 * 60_000,
  sendUpload = defaultSendUpload,
  fileSize = async (file) => (await stat(file)).size,
  ask = askOnTerminal,
}: CommandDeps) {
  const get = (id: string) => api.get<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}`);

  /** Follows a destroy until the server is gone (its record answers 404). Fails if it ends FAILED. */
  async function waitUntilGone(id: string): Promise<void> {
    let last = '';
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      let server: ServerRecord;
      try {
        server = await get(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
      }
      if (server.status !== last) print(`  ${server.status}`);
      last = server.status;
      if (server.status === 'FAILED') throw new CommandError(`Failed: ${server.statusMessage ?? 'no reason recorded'}`);
      await sleep(pollMs);
    }
    throw new CommandError(`Still not destroyed after ${Math.round(timeoutMs / 60_000)} minutes; check \`hearth status ${id}\``);
  }

  /**
   * Uploads a file of game data and waits for repack to accept it: the same steps the UI takes.
   * Returns the upload ID to create from; a rejection fails with repack's reason.
   */
  async function upload(game: string, file: string): Promise<string> {
    let bytes: number;
    try {
      bytes = await fileSize(file);
    } catch {
      throw new CommandError(`Can't read ${file}`);
    }
    if (bytes > MAX_UPLOAD_BYTES) throw new CommandError(`${file} is ${mebibytes(bytes)}; uploads can be at most ${mebibytes(MAX_UPLOAD_BYTES)}`);

    const form = await api.post<CreateUploadResponse>('/admin/uploads', { game });
    print(`Uploading ${basename(file)} (${mebibytes(bytes)})…`);
    await sendUpload(form, file);
    print('Uploaded. Checking it…');

    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const status = await api.get<UploadStatus>(`/admin/uploads/${form.uploadId}`);
      if (status.status === 'accepted') {
        print(`Accepted (${mebibytes(status.bytes)} after repacking).`);
        return form.uploadId;
      }
      if (status.status === 'rejected') throw new CommandError(`The upload was rejected: ${status.reason}`);
      await sleep(pollMs);
    }
    throw new CommandError(`Upload ${form.uploadId} still not checked after ${Math.round(timeoutMs / 60_000)} minutes`);
  }

  /** Follows the server until it reaches `target`, printing each change. Fails on FAILED or timeout. */
  async function waitFor(id: string, target: ServerStatus): Promise<ServerRecord> {
    let last = '';
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const server = await get(id);
      const line = `  ${server.status}${server.agentState ? ` · agent ${server.agentState}` : ''}`;
      if (line !== last) print(line);
      last = line;
      if (server.status === 'FAILED') throw new CommandError(`Failed: ${server.statusMessage ?? 'no reason recorded'}`);
      // Running also needs its public IP, which state sync records moments after EC2 reports running.
      if (server.status === target && (target !== 'RUNNING' || server.publicIp)) return server;
      await sleep(pollMs);
    }
    throw new CommandError(`Still not ${target} after ${Math.round(timeoutMs / 60_000)} minutes; check \`hearth status ${id}\``);
  }

  function address(server: ServerRecord): string {
    return server.publicIp ? `${server.publicIp}:${GAME_DEFINITIONS[server.game].port}` : '-';
  }

  async function followUp(result: ServerOperationResult, target: ServerStatus, wait: boolean) {
    if (!wait) return;
    const server = await waitFor(result.serverId, target);
    if (target === 'RUNNING') print(`Ready. Join at ${address(server)}   (server ${server.serverId})`);
    else if (server.lastStopClean === false) print('Stopped. The agent did not report a clean stop; the game may not be saved.');
    // A clean stop's message is a problem that didn't stop it, e.g. a failed backup.
    else print(`Stopped. Game saved.${server.agentMessage ? ` Agent: ${server.agentMessage}` : ''}`);
  }

  return {
    /**
     * Creates a server with new game data, an earlier upload (`upload`, an upload ID), or a file
     * uploaded first (`file`: upload, wait for repack to accept it, then create from it).
     */
    async create(opts: {
      game: string;
      version: string;
      region?: string;
      channel?: string;
      upload?: string;
      file?: string;
      wait: boolean;
    }) {
      if (opts.upload && opts.file) throw new CommandError('Give a file to upload or an upload ID, not both');
      const uploadId = opts.file ? await upload(opts.game, opts.file) : opts.upload;
      const result = await api.post<ServerOperationResult>('/admin/servers', {
        game: opts.game,
        version: opts.version,
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.channel ? { agentChannel: opts.channel } : {}),
        ...(uploadId ? { upload: uploadId } : {}),
      });
      const from = uploadId ? ` from upload ${uploadId}` : '';
      print(`Creating ${result.serverId} (${opts.game} ${opts.version})${from}. The first start takes a few minutes.`);
      await followUp(result, 'RUNNING', opts.wait);
    },

    async start(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(`/admin/servers/${encodeURIComponent(id)}/start`);
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Starting ${id}.`);
      await followUp(result, 'RUNNING', wait);
    },

    async stop(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(`/admin/servers/${encodeURIComponent(id)}/stop`);
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Stopping ${id}; the agent saves and backs up the game first.`);
      await followUp(result, 'STOPPED', wait);
    },

    /** Moves a server to another agent channel; it runs that channel's release from its next start. */
    /**
     * Destroys a stopped server: its instance, data volume and record; its backups are kept. Shows
     * what will go and asks for the server ID back, unless `yes`.
     */
    async destroy(id: string, opts: { yes: boolean; wait: boolean }) {
      const server = await get(id);
      if (!['STOPPED', 'FAILED', 'DESTROYING'].includes(server.status)) {
        throw new CommandError(`${id} is ${server.status}; stop it before destroying it (\`hearth stop ${id}\`)`);
      }
      if (server.status !== 'DESTROYING') {
        print(`This destroys ${id} (${server.game} ${server.version}, ${server.status}): its instance, data volume and record.`);
        print(
          server.lastBackupAt
            ? `Its backups are kept; the newest is from ${server.lastBackupAt}.`
            : 'It has no backups: its game data will be gone for good.',
        );
        if (!opts.yes && (await ask('Type the server ID to destroy it: ')).trim() !== id) {
          throw new CommandError('Not destroyed: that is not the server ID.');
        }
      }
      const result = await api.post<ServerOperationResult>(`/admin/servers/${encodeURIComponent(id)}/destroy`);
      print(result.unchanged ? `${id} is already being destroyed.` : `Destroying ${id}.`);
      if (!opts.wait) return;
      await waitUntilGone(id);
      print(`Destroyed. Its backups stay in the backups bucket under servers/${id}/.`);
    },

    async setChannel(id: string, channel: string) {
      const server = await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/settings`, { agentChannel: channel });
      print(`${server.serverId} is on the ${server.agentChannel} channel; it takes effect on the next start.`);
    },

    /** Sets how long a server may sit with nobody playing before it stops: minutes, or "off". */
    async setIdle(id: string, value: string) {
      const minutes = value === 'off' ? 0 : Number(value);
      if (!Number.isInteger(minutes) || minutes < 0) throw new CommandError('set-idle takes a whole number of minutes, or "off"');
      const body: UpdateSettingsRequest = { idleStopMinutes: minutes };
      const server = await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/settings`, body);
      print(`${server.serverId} ${idleStop(server)}, from its next start.`);
    },

    /** Moves a stopped server to a newer game release; it runs from the next start. */
    async setVersion(id: string, version: string) {
      const body: SetVersionRequest = { version };
      const server = await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/version`, body);
      print(`${server.serverId} runs ${server.game} ${server.version} from its next start.`);
    },

    async status(id: string) {
      const s = await get(id);
      const rows: [string, string | undefined][] = [
        ['server', s.serverId],
        ['game', `${s.game} ${s.version}`],
        ['status', s.status + (s.statusMessage ? ` (${s.statusMessage})` : '')],
        ['agent', s.agentState && `${s.agentState}${s.agentVersion ? ` (${s.agentVersion})` : ''}${s.agentMessage ? `: ${s.agentMessage}` : ''}`],
        ['channel', s.agentChannel ?? 'stable'],
        ['idle stop', idleStop(s)],
        ['instance', s.instanceId && `${s.instanceId} (${s.instanceState ?? 'unknown'})`],
        ['join at', s.publicIp && address(s)],
        [
          'last stop',
          s.lastStoppedAt &&
            `${s.lastStoppedAt}${s.stopReason ? `: ${s.stopReason}` : ''}${s.lastStopClean === false ? ' (not clean)' : ''}`,
        ],
        ['last backup', s.lastBackupAt && `${s.lastBackupAt} (${mebibytes(s.lastBackupBytes ?? 0)})`],
        ['restore', s.restoreKey && `${restoreName(s)} on the next start`],
      ];
      for (const [k, v] of rows) if (v) print(`${k.padEnd(11)} ${v}`);
    },

    /** Runs the fleet check now and prints what it found. */
    async fleetCheck() {
      if (!fleetCheck) throw new CommandError('fleet-check is not available here');
      const r = await fleetCheck();
      const ids = (list: string[]) => (list.length ? list.join(', ') : 'none');
      print(`running     ${r.running}`);
      print(`stuck       ${ids(r.stuck)}`);
      print(`failed      ${ids(r.failed)}`);
      print(`mismatched  ${ids(r.mismatched)}`);
      print(`untracked   ${r.untracked.length ? r.untracked.length : 'none'}`);
      for (const i of r.untracked) {
        const server = i.serverId ? `tagged server ${i.serverId}` : 'no serverId tag';
        print(`  ${i.instanceId}  ${i.region}  ${i.state}  launched ${i.launchedAt ?? 'unknown'}  ${server}`);
      }
      if (r.stuck.length + r.failed.length + r.mismatched.length + r.untracked.length === 0) print('All clear.');
    },

    async list() {
      const servers: ServerRecord[] = [];
      let cursor: string | undefined;
      do {
        const page: ListServersResponse = await api.get('/admin/servers', { limit: '100', cursor });
        servers.push(...page.servers);
        cursor = page.cursor;
      } while (cursor);
      if (servers.length === 0) return print('No servers.');
      table([
        ['SERVER', 'GAME', 'VERSION', 'STATUS', 'AGENT', 'ADDRESS'],
        ...servers
          .sort((a, b) => a.serverId.localeCompare(b.serverId))
          .map((s) => [s.serverId, s.game, s.version, s.status, s.agentState ?? '-', address(s)]),
      ]);
    },

    async backups(id: string) {
      const { backups } = await api.get<ListBackupsResponse>(`/admin/servers/${encodeURIComponent(id)}/backups`);
      if (backups.length === 0) return print('No backups yet. One is taken each time the server stops.');
      table([['TAKEN', 'SIZE', 'KEY'], ...backups.map((b) => [b.takenAt, mebibytes(b.bytes), b.key])]);
    },

    /** Asks for a backup to replace the game data on the next start; nothing happens until then. */
    async restore(id: string, key: string | undefined, force: boolean) {
      const body: RestoreRequest = { ...(key ? { key } : {}), ...(force ? { force } : {}) };
      const server = await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/restore`, body);
      print(`${server.serverId} will restore ${server.restoreKey} on its next start, replacing the current game data.`);
      print(`Start it with \`hearth start ${server.serverId}\`, or cancel with \`hearth restore ${server.serverId} --cancel\`.`);
    },

    async cancelRestore(id: string) {
      await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/restore/cancel`);
      print(`No restore pending for ${id}.`);
    },
  };

  function table(rows: string[][]) {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) print(r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  }
}

/** A pending restore as people know it: the backup's key, or "upload <id>" for a server created from one. */
function restoreName(server: ServerRecord): string {
  const key = server.restoreKey ?? '';
  return server.restoreSource === 'upload' ? `upload ${key.replace(/^accepted\//, '').replace(/\.tar\.gz$/, '')}` : key;
}

/** "stops after 30 minutes with nobody playing", or "never stops for being idle". */
function idleStop(server: ServerRecord): string {
  const minutes = server.idleStopMinutes ?? DEFAULT_IDLE_STOP_MINUTES;
  if (minutes === 0) return 'never stops for being idle';
  return `stops after ${minutes === 1 ? '1 minute' : `${minutes} minutes`} with nobody playing`;
}

function mebibytes(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}
