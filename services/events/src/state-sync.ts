import type { EventBridgeEvent } from 'aws-lambda';
import type { ServersStore } from '@hearth/core';
import { isInstanceState } from '@hearth/shared';

export type Ec2StateChange = EventBridgeEvent<
  'EC2 Instance State-change Notification',
  { 'instance-id': string; state: string }
>;

export interface InstanceInfo {
  tags: Record<string, string>;
}

export interface StateSyncDeps {
  env: string;
  store: Pick<ServersStore, 'findByInstance' | 'recordInstanceState' | 'transition'>;
  /** Looks up an instance in EC2; undefined if it no longer exists. */
  describeInstance(region: string, instanceId: string): Promise<InstanceInfo | undefined>;
  log?: (entry: Record<string, unknown>) => void;
}

/** Thrown to make Lambda retry the event later. */
export class RetryLater extends Error {}

/**
 * Handles EC2 instance state changes, which EventBridge delivers for every instance in the
 * account. Records the instance's state on its server (the workflow records the public IP with
 * RUNNING; any other state clears it), and marks a running server
 * STOPPED when its instance stops without the stop workflow (maintenance, a shutdown from inside,
 * idle shutdown).
 */
export function stateSync({ env, store, describeInstance, log = defaultLog }: StateSyncDeps) {
  return async function handle(event: Ec2StateChange): Promise<void> {
    const instanceId = event.detail['instance-id'];
    const state = event.detail.state;
    if (!isInstanceState(state)) {
      log({ msg: 'ignoring unknown instance state', instanceId, state });
      return;
    }

    const server = await store.findByInstance(instanceId);
    if (!server) {
      // Not ours, unless it's a just-launched instance tagged for this environment: then its
      // record is still being written (the create workflow records instanceId right after
      // launch), so try again shortly. Only "running" can race the create workflow, so other
      // states of unknown instances end here without asking EC2.
      if (state !== 'running') return;
      const instance = await describeInstance(event.region, instanceId);
      if (instance?.tags.app === 'hearth' && instance.tags.env === env) {
        throw new RetryLater(`No server records instance ${instanceId} yet`);
      }
      return;
    }

    const at = new Date(event.time);
    const recorded = await store.recordInstanceState(server.serverId, instanceId, state, at);
    if (!recorded) {
      log({ msg: 'ignoring stale event', serverId: server.serverId, instanceId, state, at: event.time });
      return;
    }
    log({ msg: 'instance state recorded', serverId: server.serverId, instanceId, state });

    // Stops through the stop workflow are STOPPING, and the workflow finishes them. A RUNNING
    // server whose instance stopped was stopped some other way.
    if (state === 'stopped' && (await store.transition(server.serverId, { from: ['RUNNING'], to: 'STOPPED', instanceId }))) {
      log({ msg: 'server stopped outside the stop workflow', serverId: server.serverId, instanceId });
    }
  };
}

function defaultLog(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}
