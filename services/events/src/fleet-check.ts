import type { Metrics, ServersStore, StatusIndexEntry } from '@hearth/core';
import { METRICS, type ServerStatus } from '@hearth/shared';

/** Statuses a workflow moves a server through; staying in one this long means it's stuck. */
const TRANSITIONAL: readonly ServerStatus[] = ['PROVISIONING', 'STARTING', 'STOPPING'];
/** Workflows time out after 30 minutes; stuck = longer than that plus a margin. */
const STUCK_AFTER_MINUTES = 35;

export interface FleetCheckDeps {
  store: Pick<ServersStore, 'findByStatus'>;
  metrics: Metrics;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

export interface FleetReport {
  stuck: string[];
  failed: string[];
  mismatched: string[];
  running: number;
}

/**
 * Reconciles the fleet independently of the workflows: finds servers the other processes left in a
 * bad state (stuck mid-transition, FAILED, or RUNNING while EC2 says the instance isn't).
 */
export function fleetCheck({ store, metrics, now = () => new Date(), log = defaultLog }: FleetCheckDeps) {
  return async function handle(): Promise<FleetReport> {
    const cutoff = new Date(now().getTime() - STUCK_AFTER_MINUTES * 60_000);
    const [stuck, failed, running] = await Promise.all([
      Promise.all(TRANSITIONAL.map((status) => store.findByStatus(status, cutoff))).then((lists) => lists.flat()),
      store.findByStatus('FAILED'),
      store.findByStatus('RUNNING'),
    ]);
    const mismatched = running.filter((s) => s.instanceState !== undefined && s.instanceState !== 'running');

    metrics.record(METRICS.stuckServers, stuck.length, 'Count');
    metrics.record(METRICS.failedServers, failed.length, 'Count');
    metrics.record(METRICS.runningServers, running.length, 'Count');
    metrics.record(METRICS.statusMismatches, mismatched.length, 'Count');

    const describe = (s: StatusIndexEntry) => ({ serverId: s.serverId, status: s.status, since: s.statusChangedAt, instanceState: s.instanceState });
    for (const s of stuck) log({ msg: 'stuck server', ...describe(s) });
    for (const s of failed) log({ msg: 'failed server', ...describe(s) });
    for (const s of mismatched) log({ msg: 'status mismatch', ...describe(s) });

    const report = {
      stuck: stuck.map((s) => s.serverId),
      failed: failed.map((s) => s.serverId),
      mismatched: mismatched.map((s) => s.serverId),
      running: running.length,
    };
    log({ msg: 'fleet check', ...report });
    return report;
  };
}

function defaultLog(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}
