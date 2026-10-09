import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  DEFAULT_IDLE_STOP_MINUTES,
  GAME_DEFINITIONS,
  MAX_UPLOAD_BYTES,
  type AgentChannel,
  type CreateServerRequest,
  type CreateUploadResponse,
  type FleetReport,
  type GameId,
  type ListMyServersResponse,
  type ListServersResponse,
  type RestoreRequest,
  type ServerBackupsResponse,
  type ServerOperationResult,
  type ServerRecord,
  type ServerStatus,
  type ServerView,
  type SetApprovalRequest,
  type SetVersionRequest,
  type UpdateSettingsRequest,
  type UploadStatus,
  type UserRecord,
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
  /** The /v1 API, as the signed-in user (`hearth login`). */
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
  const path = (id: string, rest = '') => `/v1/servers/${encodeURIComponent(id)}${rest}`;
  const get = (id: string) => api.get<ServerView>(path(id));

  /** An admin route's answer, or undefined when the caller isn't an admin (they get what users see). */
  async function asAdmin<T>(request: () => Promise<T>): Promise<T | undefined> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return undefined;
      throw err;
    }
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

    const form = await api.post<CreateUploadResponse>('/v1/uploads', { game });
    print(`Uploading ${basename(file)} (${mebibytes(bytes)})…`);
    await sendUpload(form, file);
    print('Uploaded. Checking it…');

    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const status = await api.get<UploadStatus>(`/v1/uploads/${form.uploadId}`);
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
  async function waitFor(id: string, target: ServerStatus): Promise<ServerView> {
    let last = '';
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      const server = await get(id);
      const line = `  ${server.status}${server.gameState ? ` · game ${server.gameState}` : ''}`;
      if (line !== last) print(line);
      last = line;
      if (server.status === 'FAILED') throw new CommandError(`Failed: ${server.statusMessage ?? 'no reason recorded'}`);
      // The workflow records RUNNING together with the address, so there's nothing more to wait for.
      if (server.status === target) return server;
      await sleep(pollMs);
    }
    throw new CommandError(`Still not ${target} after ${Math.round(timeoutMs / 60_000)} minutes; check \`hearth status ${id}\``);
  }

  async function followUp(result: ServerOperationResult, target: ServerStatus, wait: boolean) {
    if (!wait) return;
    const server = await waitFor(result.serverId, target);
    if (target === 'RUNNING') print(`Ready. Join at ${joinAddress(server.game, server.address)}   (server ${server.serverId})`);
    else if (server.lastStopClean === false) print('Stopped. The agent did not report a clean stop; the game may not be saved.');
    else print('Stopped. Game saved.');
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
      const body: CreateServerRequest = {
        game: opts.game as GameId,
        version: opts.version,
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.channel ? { agentChannel: opts.channel as AgentChannel } : {}),
        ...(uploadId ? { upload: uploadId } : {}),
      };
      const result = await api.post<ServerOperationResult>('/v1/servers', body);
      const from = uploadId ? ` from upload ${uploadId}` : '';
      print(`Creating ${result.serverId} (${opts.game} ${opts.version})${from}. The first start takes a few minutes.`);
      await followUp(result, 'RUNNING', opts.wait);
    },

    async start(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(path(id, '/start'));
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Starting ${id}.`);
      await followUp(result, 'RUNNING', wait);
    },

    async stop(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(path(id, '/stop'));
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Stopping ${id}; the agent saves and backs up the game first.`);
      await followUp(result, 'STOPPED', wait);
    },

    /**
     * Destroys a stopped server: its instance and data volume. Its record (now DESTROYED) and
     * backups are kept. Shows what will go and asks for the server ID back, unless `yes`.
     */
    async destroy(id: string, opts: { yes: boolean; wait: boolean }) {
      const server = await get(id);
      if (server.status === 'DESTROYED') return print(`${id} was already destroyed on ${server.destroyedAt ?? 'an unknown date'}.`);
      if (!['STOPPED', 'FAILED', 'DESTROYING'].includes(server.status)) {
        throw new CommandError(`${id} is ${server.status}; stop it before destroying it (\`hearth stop ${id}\`)`);
      }
      if (server.status !== 'DESTROYING') {
        print(`This destroys ${id} (${server.game} ${server.version}, ${server.status}): its instance and data volume.`);
        print(
          server.lastBackupAt
            ? `Its backups are kept; the newest is from ${server.lastBackupAt}.`
            : 'It has no backups: its game data will be gone for good.',
        );
        if (!opts.yes && (await ask('Type the server ID to destroy it: ')).trim() !== id) {
          throw new CommandError('Not destroyed: that is not the server ID.');
        }
      }
      const result = await api.post<ServerOperationResult>(path(id, '/destroy'));
      print(result.unchanged ? `${id} is already being destroyed.` : `Destroying ${id}.`);
      if (!opts.wait) return;
      await waitFor(id, 'DESTROYED');
      print(`Destroyed. Its backups are kept: \`hearth backups ${id}\`.`);
    },

    /** Moves a server to another agent channel (admins); it runs that channel's release from its next start. */
    async setChannel(id: string, channel: string) {
      const body: UpdateSettingsRequest = { agentChannel: channel as AgentChannel };
      const server = await api.patch<ServerView>(path(id), body);
      print(`${server.serverId} is on the ${channel} channel; it takes effect on the next start.`);
    },

    /** Sets how long a server may sit with nobody playing before it stops: minutes, or "off". */
    async setIdle(id: string, value: string) {
      const minutes = value === 'off' ? 0 : Number(value);
      if (!Number.isInteger(minutes) || minutes < 0) throw new CommandError('set-idle takes a whole number of minutes, or "off"');
      const body: UpdateSettingsRequest = { idleStopMinutes: minutes };
      const server = await api.patch<ServerView>(path(id), body);
      print(`${server.serverId} ${idleStop(server.idleStopMinutes)}, from its next start.`);
    },

    /** Moves a stopped server to a newer game release; it runs from the next start. */
    async setVersion(id: string, version: string) {
      const body: SetVersionRequest = { version };
      const server = await api.post<ServerView>(path(id, '/version'), body);
      print(`${server.serverId} runs ${server.game} ${server.version} from its next start.`);
    },

    /** A server: for admins its whole record (instance and agent too); for others what owners and members see. */
    async status(id: string) {
      const record = await asAdmin(() => api.get<ServerRecord>(`/v1/admin/servers/${encodeURIComponent(id)}`));
      if (record) return statusOf(record);
      const s = await get(id);
      const rows: [string, string | undefined][] = [
        ['server', s.serverId],
        ['you are', s.role],
        ['game', `${s.game} ${s.version}`],
        ['status', s.status + (s.statusMessage ? ` (${s.statusMessage})` : '')],
        ['game state', s.gameState],
        ['idle stop', idleStop(s.idleStopMinutes)],
        ['join at', s.address && joinAddress(s.game, s.address)],
        ['last start', s.lastStartedAt],
        [
          'last stop',
          s.lastStoppedAt &&
            `${s.lastStoppedAt}${s.stopReason ? `: ${s.stopReason}` : ''}${s.lastStopClean === false ? ' (not clean)' : ''}`,
        ],
        ['last backup', s.lastBackupAt],
        ['restore', s.restorePending ? 'pending: replaces the game data on the next start' : undefined],
        ['destroyed', s.destroyedAt],
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

    /**
     * Servers, sorted by ID; destroyed ones only with `all`. Admins see every server; anyone else
     * the ones they own or are a member of.
     */
    async list(all = false) {
      const every = await asAdmin(async () => {
        const servers: ServerRecord[] = [];
        let cursor: string | undefined;
        do {
          const page: ListServersResponse = await api.get('/v1/admin/servers', { limit: '100', cursor, ...(all ? { all: 'true' } : {}) });
          servers.push(...page.servers);
          cursor = page.cursor;
        } while (cursor);
        return servers.map((s) => [s.serverId, s.game, s.version, s.status, s.agentState ?? '-', joinAddress(s.game, s.publicIp)]);
      });
      const rows =
        every ??
        (await api.get<ListMyServersResponse>('/v1/servers', all ? { all: 'true' } : {})).servers.map((s) => [
          s.serverId,
          s.game,
          s.version,
          s.status,
          s.gameState ?? '-',
          joinAddress(s.game, s.address),
        ]);
      if (rows.length === 0) return print('No servers.');
      table([['SERVER', 'GAME', 'VERSION', 'STATUS', every ? 'AGENT' : 'GAME STATE', 'ADDRESS'], ...rows.sort((a, b) => a[0]!.localeCompare(b[0]!))]);
    },

    async backups(id: string) {
      const { backups } = await api.get<ServerBackupsResponse>(path(id, '/backups'));
      if (backups.length === 0) return print('No backups yet. One is taken each time the server stops.');
      table([['TAKEN', 'SIZE', 'BACKUP'], ...backups.map((b) => [b.takenAt, mebibytes(b.bytes), b.id])]);
    },

    /** Asks for a backup (by name; default: the newest) to replace the game data on the next start. */
    async restore(id: string, key: string | undefined, force: boolean) {
      const body: RestoreRequest = { ...(key ? { key } : {}), ...(force ? { force } : {}) };
      const server = await api.post<ServerView>(path(id, '/restore'), body);
      print(`${server.serverId} will restore ${key ?? 'its newest backup'} on its next start, replacing the current game data.`);
      print(`Start it with \`hearth start ${server.serverId}\`, or cancel with \`hearth restore ${server.serverId} --cancel\`.`);
    },

    async cancelRestore(id: string) {
      await api.delete<ServerView>(path(id, '/restore'));
      print(`No restore pending for ${id}.`);
    },

    /** Approves a user (they may create servers), or takes it back; their servers keep running. */
    async approve(userId: string, approved: boolean) {
      const body: SetApprovalRequest = { approved };
      const user = await api.post<UserRecord>(`/v1/admin/users/${encodeURIComponent(userId)}/approval`, body);
      const who = user.displayName ?? user.name ?? user.username ?? user.email ?? user.userId;
      print(
        user.approved
          ? `${who} is approved: they can create up to ${user.serverLimit} servers.`
          : `${who} is no longer approved: they can't create servers (the ones they have keep running).`,
      );
    },
  };

  /** A server's whole record, as admins see it. */
  function statusOf(s: ServerRecord) {
    const rows: [string, string | undefined][] = [
      ['server', s.serverId],
      ['owner', s.ownerId],
      ['game', `${s.game} ${s.version}`],
      ['status', s.status + (s.statusMessage ? ` (${s.statusMessage})` : '')],
      ['agent', s.agentState && `${s.agentState}${s.agentVersion ? ` (${s.agentVersion})` : ''}${s.agentMessage ? `: ${s.agentMessage}` : ''}`],
      ['channel', s.agentChannel ?? 'stable'],
      ['idle stop', idleStop(s.idleStopMinutes)],
      ['instance', s.instanceId && `${s.instanceId} (${s.instanceState ?? 'unknown'})`],
      ['join at', s.status === 'RUNNING' && s.publicIp ? joinAddress(s.game, s.publicIp) : undefined],
      ['last start', s.lastStartedAt],
      [
        'last stop',
        s.lastStoppedAt &&
          `${s.lastStoppedAt}${s.stopReason ? `: ${s.stopReason}` : ''}${s.lastStopClean === false ? ' (not clean)' : ''}`,
      ],
      ['last backup', s.lastBackupAt && `${s.lastBackupAt} (${mebibytes(s.lastBackupBytes ?? 0)})`],
      ['restore', s.restoreKey && `${restoreName(s)} on the next start`],
      ['destroyed', s.destroyedAt],
    ];
    for (const [k, v] of rows) if (v) print(`${k.padEnd(11)} ${v}`);
  }

  function table(rows: string[][]) {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) print(r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  }
}

/** A pending restore as admins know it: the backup's key, or "upload <id>" for a server created from one. */
function restoreName(server: ServerRecord): string {
  const key = server.restoreKey ?? '';
  return server.restoreSource === 'upload' ? `upload ${key.replace(/^accepted\//, '').replace(/\.tar\.gz$/, '')}` : key;
}

/** Where players connect: the address and the game's port, or "-". */
function joinAddress(game: GameId, ip: string | undefined): string {
  return ip ? `${ip}:${GAME_DEFINITIONS[game].port}` : '-';
}

/** "stops after 30 minutes with nobody playing", or "never stops for being idle". */
function idleStop(minutes: number = DEFAULT_IDLE_STOP_MINUTES): string {
  if (minutes === 0) return 'never stops for being idle';
  return `stops after ${minutes === 1 ? '1 minute' : `${minutes} minutes`} with nobody playing`;
}

function mebibytes(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}
