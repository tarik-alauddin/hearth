import { metricsNamespace } from '@hearth/shared';

export type MetricUnit = 'Count' | 'Seconds' | 'None';

export interface Metrics {
  record(name: string, value: number, unit: MetricUnit, dimensions?: Record<string, string>): void;
}

/**
 * Metrics in CloudWatch's embedded metric format: one JSON log line per data point, which
 * CloudWatch Logs turns into a metric in `Hearth/<env>`. No API calls or extra permissions.
 */
export function emfMetrics(env: string, write: (line: string) => void = (line) => console.log(line)): Metrics {
  return {
    record(name, value, unit, dimensions = {}) {
      write(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              { Namespace: metricsNamespace(env), Dimensions: [Object.keys(dimensions)], Metrics: [{ Name: name, Unit: unit }] },
            ],
          },
          ...dimensions,
          [name]: value,
        }),
      );
    },
  };
}
