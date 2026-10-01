import { describe, expect, it } from 'vitest';
import type { StatusIndexEntry } from '@hearth/core';
import type { ServerStatus } from '@hearth/shared';
import { fleetCheck } from './fleet-check.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/** A byStatus index over these entries, with the store's time filter. */
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
    },
  };
}

function run(entries: StatusIndexEntry[]) {
  const { store, queries } = fakeStore(entries);
  const metrics: Record<string, number> = {};
  const logs: Record<string, unknown>[] = [];
  const check = fleetCheck({
    store,
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
    expect(await check()).toEqual({ stuck: [], failed: [], mismatched: [], running: 1 });
    expect(metrics).toEqual({ StuckServers: 0, FailedServers: 0, RunningServers: 1, StatusMismatches: 0 });
    expect(queries.sort()).toEqual([
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
      { serverId: 'fresh', status: 'PROVISIONING', statusChangedAt: ago(10) },
    ]);
    expect((await check()).stuck.sort()).toEqual(['old-start', 'old-stop']);
    expect(logs.filter((l) => l.msg === 'stuck server')).toHaveLength(2);
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
});
