// Custom CloudWatch metrics. Lambdas emit them (embedded metric format); MonitoringStack alarms on
// and charts them. One namespace per environment: `Hearth/<env>`.

export const metricsNamespace = (env: string) => `Hearth/${env}`;

export const METRICS = {
  /** Seconds from launch/start to the agent reporting ready. Dimension: Workflow (create | start). */
  timeToReady: 'TimeToReady',
  /** 1 if the agent reported a clean stop (game saved), else 0. One data point per stop. */
  stopClean: 'StopClean',
  /** Fleet check: servers mid-transition for longer than the workflow timeout allows. */
  stuckServers: 'StuckServers',
  /** Fleet check: servers in FAILED. */
  failedServers: 'FailedServers',
  /** Fleet check: servers in RUNNING. */
  runningServers: 'RunningServers',
  /** Fleet check: RUNNING servers whose instance EC2 says isn't running. */
  statusMismatches: 'StatusMismatches',
  /** Fleet check: this environment's Hearth instances that no server record points at. */
  untrackedInstances: 'UntrackedInstances',
} as const;
