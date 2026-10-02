// The fleet check's report: returned when invoked (`hearth fleet-check`), logged when scheduled.

/** The fleet check Lambda, named so the CLI can invoke it. */
export const fleetCheckFunctionName = (env: string) => `hearth-${env}-fleet-check`;

/** A Hearth instance of this environment that no server record points at. */
export interface UntrackedInstance {
  instanceId: string;
  region: string;
  state: string;
  launchedAt?: string;
  /** Its serverId tag, if any: the server it was launched for. */
  serverId?: string;
}

export interface FleetReport {
  /** Server IDs mid-transition for longer than a workflow can take. */
  stuck: string[];
  failed: string[];
  /** RUNNING servers whose instance EC2 says isn't running. */
  mismatched: string[];
  untracked: UntrackedInstance[];
  running: number;
}
