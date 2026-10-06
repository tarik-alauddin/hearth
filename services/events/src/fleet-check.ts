import type { Metrics, ServersStore, StatusIndexEntry } from '@hearth/core';
import { METRICS, type FleetReport, type ServerStatus, type UntrackedInstance } from '@hearth/shared';

/** Statuses a workflow moves a server through; staying in one this long means it's stuck. */
const TRANSITIONAL: readonly ServerStatus[] = ['PROVISIONING', 'STARTING', 'STOPPING', 'DESTROYING'];
/** Workflows time out after 30 minutes; stuck = longer than that plus a margin. */
const STUCK_AFTER_MINUTES = 35;
/** A launch records its instance seconds after RunInstances; younger instances aren't judged. */
const UNTRACKED_AFTER_MINUTES = 10;

/** This environment's Hearth instances in a region (any state but terminated). */
export interface FleetEc2 {
  hearthInstances(region: string): Promise<Omit<UntrackedInstance, 'region'>[]>;
}

export interface FleetCheckDeps {
  store: Pick<ServersStore, 'findByStatus' | 'findByInstance'>;
  ec2: FleetEc2;
  /** Game regions to look for instances in. */
  regions: readonly string[];
  metrics: Metrics;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * Reconciles the fleet independently of the workflows: finds servers the other processes left in a
 * bad state (stuck mid-transition, FAILED, or RUNNING while EC2 says the instance isn't), and
 * instances no server knows about. It only reports; fixing is left to a person.
 */
export function fleetCheck({ store, ec2, regions, metrics, now = () => new Date(), log = defaultLog }: FleetCheckDeps) {
  /** Instances older than the grace period that no server record points at. */
  async function findUntracked(): Promise<UntrackedInstance[]> {
    const cutoff = new Date(now().getTime() - UNTRACKED_AFTER_MINUTES * 60_000).toISOString();
    const perRegion = await Promise.all(
      regions.map(async (region) => (await ec2.hearthInstances(region)).map((i) => ({ ...i, region }))),
    );
    const settled = perRegion.flat().filter((i) => !i.launchedAt || i.launchedAt < cutoff);
    const owners = await Promise.all(settled.map((i) => store.findByInstance(i.instanceId)));
    return settled.filter((_, n) => !owners[n]);
  }

  return async function handle(): Promise<FleetReport> {
    const cutoff = new Date(now().getTime() - STUCK_AFTER_MINUTES * 60_000);
    const [stuck, failed, running, untracked] = await Promise.all([
      Promise.all(TRANSITIONAL.map((status) => store.findByStatus(status, cutoff))).then((lists) => lists.flat()),
      store.findByStatus('FAILED'),
      store.findByStatus('RUNNING'),
      findUntracked(),
    ]);
    const mismatched = running.filter((s) => s.instanceState !== undefined && s.instanceState !== 'running');

    metrics.record(METRICS.stuckServers, stuck.length, 'Count');
    metrics.record(METRICS.failedServers, failed.length, 'Count');
    metrics.record(METRICS.runningServers, running.length, 'Count');
    metrics.record(METRICS.statusMismatches, mismatched.length, 'Count');
    metrics.record(METRICS.untrackedInstances, untracked.length, 'Count');

    const describe = (s: StatusIndexEntry) => ({ serverId: s.serverId, status: s.status, since: s.statusChangedAt, instanceState: s.instanceState });
    for (const s of stuck) log({ msg: 'stuck server', ...describe(s) });
    for (const s of failed) log({ msg: 'failed server', ...describe(s) });
    for (const s of mismatched) log({ msg: 'status mismatch', ...describe(s) });
    for (const i of untracked) log({ msg: 'untracked instance', ...i });

    const report = {
      stuck: stuck.map((s) => s.serverId),
      failed: failed.map((s) => s.serverId),
      mismatched: mismatched.map((s) => s.serverId),
      untracked,
      running: running.length,
    };
    log({ msg: 'fleet check', ...report });
    return report;
  };
}

function defaultLog(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}
