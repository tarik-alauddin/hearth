// Lambda entry point for the fleet check. Scheduled in prod; run on demand elsewhere
// (`aws lambda invoke --function-name <name> out.json` returns the report).
import { createServersStore, emfMetrics } from '@hearth/core';
import { fleetCheck } from './fleet-check.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const handler = fleetCheck({
  store: createServersStore(requireEnv('SERVERS_TABLE')),
  metrics: emfMetrics(requireEnv('HEARTH_ENV')),
});
