import {
  GAME_DEFINITIONS,
  type FleetReport,
  type ListBackupsResponse,
  type ListServersResponse,
  type ServerOperationResult,
  type ServerRecord,
  type ServerStatus,
} from '@hearth/shared';
import type { Api } from './client.js';

export interface CommandDeps {
  api: Api;
  /** Runs the fleet check Lambda and returns its report. */
  fleetCheck?: () => Promise<FleetReport>;
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How often to check progress while waiting, and for how long. */
  pollMs?: number;
  timeoutMs?: number;
}

/** Stop waiting with a non-zero exit; the message says why. */
export class CommandError extends Error {}

export function commands({ api, fleetCheck, print, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5_000, timeoutMs = 20 * 60_000 }: CommandDeps) {
  const get = (id: string) => api.get<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}`);

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
    else if (server.lastStopClean === false) print('Stopped. The agent did not report a clean stop; the world may not be saved.');
    // A clean stop's message is a problem that didn't stop it, e.g. a failed backup.
    else print(`Stopped. World saved.${server.agentMessage ? ` Agent: ${server.agentMessage}` : ''}`);
  }

  return {
    async create(opts: { game: string; version: string; region?: string; channel?: string; wait: boolean }) {
      const result = await api.post<ServerOperationResult>('/admin/servers', {
        game: opts.game,
        version: opts.version,
        ...(opts.region ? { region: opts.region } : {}),
        ...(opts.channel ? { agentChannel: opts.channel } : {}),
      });
      print(`Creating ${result.serverId} (${opts.game} ${opts.version}). The first start takes a few minutes.`);
      await followUp(result, 'RUNNING', opts.wait);
    },

    async start(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(`/admin/servers/${encodeURIComponent(id)}/start`);
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Starting ${id}.`);
      await followUp(result, 'RUNNING', wait);
    },

    async stop(id: string, wait: boolean) {
      const result = await api.post<ServerOperationResult>(`/admin/servers/${encodeURIComponent(id)}/stop`);
      print(result.unchanged ? `Already ${result.status.toLowerCase()}.` : `Stopping ${id}; the agent saves and backs up the world first.`);
      await followUp(result, 'STOPPED', wait);
    },

    /** Moves a server to another agent channel; it runs that channel's release from its next start. */
    async setChannel(id: string, channel: string) {
      const server = await api.post<ServerRecord>(`/admin/servers/${encodeURIComponent(id)}/settings`, { agentChannel: channel });
      print(`${server.serverId} is on the ${server.agentChannel} channel; it takes effect on the next start.`);
    },

    async status(id: string) {
      const s = await get(id);
      const rows: [string, string | undefined][] = [
        ['server', s.serverId],
        ['game', `${s.game} ${s.version}`],
        ['status', s.status + (s.statusMessage ? ` (${s.statusMessage})` : '')],
        ['agent', s.agentState && `${s.agentState}${s.agentVersion ? ` (${s.agentVersion})` : ''}${s.agentMessage ? `: ${s.agentMessage}` : ''}`],
        ['channel', s.agentChannel ?? 'stable'],
        ['instance', s.instanceId && `${s.instanceId} (${s.instanceState ?? 'unknown'})`],
        ['join at', s.publicIp && address(s)],
        ['last stop', s.lastStoppedAt && `${s.lastStoppedAt}${s.lastStopClean === false ? ' (not clean)' : ''}`],
        ['last backup', s.lastBackupAt && `${s.lastBackupAt} (${mebibytes(s.lastBackupBytes ?? 0)})`],
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
  };

  function table(rows: string[][]) {
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) print(r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  }
}

function mebibytes(bytes: number): string {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}
