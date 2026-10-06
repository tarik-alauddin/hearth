import { describe, expect, it } from 'vitest';
import type { StatusIndexEntry } from '@hearth/core';
import type { ServerRecord, ServerStatus, UntrackedInstance } from '@hearth/shared';
import { fleetCheck } from './fleet-check.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** The byStatus and byInstance indexes over these entries, with the store's time filter. */
function fakeStore(entries: StatusIndexEntry[]) {
  const queries: string[] = [];
  return {
    queries,
    store: {
      findByStatus: async (status: ServerStatus, changedBefore?: Date) => {
        queries.push(`${status}${changedBefore ? ` before ${changedBefore.toISOString()}` : ''}`);
        return entries.filter(
          (e) => e.status === status && (!changedBefore || (e.statusChangedAt ?? '') < changedBefore.toISOString()),
        );
      },
      findByInstance: async (instanceId: string) =>
        entries.find((e) => e.instanceId === instanceId) as ServerRecord | undefined,
    },
  };
}

function run(entries: StatusIndexEntry[], instances: Record<string, Omit<UntrackedInstance, 'region'>[]> = {}) {
  const { store, queries } = fakeStore(entries);
  const metrics: Record<string, number> = {};
  const logs: Record<string, unknown>[] = [];
  const check = fleetCheck({
    store,
    ec2: { hearthInstances: async (region) => instances[region] ?? [] },
    regions: ['us-west-2', 'us-east-1'],
    metrics: { record: (name, value) => (metrics[name] = value) },
    now: () => NOW,
    log: (e) => logs.push(e),
  });
  return { check, metrics, logs, queries };
}

describe('fleet check', () => {
  it('reports a healthy fleet as zeros, querying the index rather than scanning', async () => {
    const { check, metrics, queries } = run([
      { serverId: 'a', status: 'RUNNING', statusChangedAt: ago(120), instanceState: 'running' },
      { serverId: 'b', status: 'STOPPED', statusChangedAt: ago(500) },
      { serverId: 'c', status: 'STARTING', statusChangedAt: ago(3) },
    ]);
    expect(await check()).toEqual({ stuck: [], failed: [], mismatched: [], untracked: [], running: 1 });
    expect(metrics).toEqual({ StuckServers: 0, FailedServers: 0, RunningServers: 1, StatusMismatches: 0, UntrackedInstances: 0 });
    expect(queries.sort()).toEqual([
      `DESTROYING before ${ago(35)}`,
      'FAILED',
      `PROVISIONING before ${ago(35)}`,
      'RUNNING',
      `STARTING before ${ago(35)}`,
      `STOPPING before ${ago(35)}`,
    ]);
  });

  it('finds servers stuck mid-transition for more than 35 minutes', async () => {
    const { check, logs } = run([
      { serverId: 'old-start', status: 'STARTING', statusChangedAt: ago(40) },
      { serverId: 'old-stop', status: 'STOPPING', statusChangedAt: ago(90) },
      { serverId: 'old-destroy', status: 'DESTROYING', statusChangedAt: ago(60) },
      { serverId: 'fresh', status: 'PROVISIONING', statusChangedAt: ago(10) },
    ]);
    expect((await check()).stuck.sort()).toEqual(['old-destroy', 'old-start', 'old-stop']);
    expect(logs.filter((l) => l.msg === 'stuck server')).toHaveLength(3);
  });

  it('counts FAILED servers', async () => {
    const { check, metrics } = run([{ serverId: 'f', status: 'FAILED', statusChangedAt: ago(5) }]);
    expect((await check()).failed).toEqual(['f']);
    expect(metrics.FailedServers).toBe(1);
  });

  it('flags RUNNING servers whose instance is not running', async () => {
    const { check, metrics } = run([
      { serverId: 'ok', status: 'RUNNING', statusChangedAt: ago(5), instanceState: 'running' },
      { serverId: 'gone', status: 'RUNNING', statusChangedAt: ago(5), instanceState: 'stopped' },
      { serverId: 'unknown', status: 'RUNNING', statusChangedAt: ago(5) },
    ]);
    expect((await check()).mismatched).toEqual(['gone']);
    expect(metrics.StatusMismatches).toBe(1);
  });

  it('lists instances in any game region that no server points at, once past the launch grace period', async () => {
    const { check, metrics, logs } = run([{ serverId: 'a', status: 'RUNNING', statusChangedAt: ago(60), instanceId: 'i-known' }], {
      'us-west-2': [
        { instanceId: 'i-known', state: 'running', launchedAt: ago(60), serverId: 'a' },
        { instanceId: 'i-orphan', state: 'running', launchedAt: ago(30), serverId: 'gone' },
        { instanceId: 'i-launching', state: 'pending', launchedAt: ago(1), serverId: 'b' },
      ],
      'us-east-1': [{ instanceId: 'i-stray', state: 'stopped', launchedAt: ago(600) }],
    });
    const { untracked } = await check();
    expect(untracked).toEqual([
      { instanceId: 'i-orphan', region: 'us-west-2', state: 'running', launchedAt: ago(30), serverId: 'gone' },
      { instanceId: 'i-stray', region: 'us-east-1', state: 'stopped', launchedAt: ago(600) },
    ]);
    expect(metrics.UntrackedInstances).toBe(2);
    expect(logs.filter((l) => l.msg === 'untracked instance').map((l) => l.instanceId)).toEqual(['i-orphan', 'i-stray']);
  });
});
