import { describe, expect, it } from 'vitest';
import { emfMetrics } from './metrics.js';

describe('emfMetrics', () => {
  it('writes one embedded-metric-format line per data point', () => {
    const lines: string[] = [];
    emfMetrics('dev', (l) => lines.push(l)).record('TimeToReady', 95, 'Seconds', { Workflow: 'start' });
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          { Namespace: 'Hearth/dev', Dimensions: [['Workflow']], Metrics: [{ Name: 'TimeToReady', Unit: 'Seconds' }] },
        ],
      },
      Workflow: 'start',
      TimeToReady: 95,
    });
    expect(typeof line._aws.Timestamp).toBe('number');
  });

  it('supports metrics without dimensions', () => {
    const lines: string[] = [];
    emfMetrics('prod', (l) => lines.push(l)).record('StuckServers', 0, 'Count');
    expect(JSON.parse(lines[0]!)._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });
});
