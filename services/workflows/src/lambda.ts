// Lambda entry points for the workflow tasks. OrchestrationStack runs three functions, grouped by the
// permissions they need; each only dispatches the tasks it's allowed to run.
import { createServersStore } from '@hearth/core';
import { sdkEc2 } from './ec2.js';
import { workflowTasks, type GameInfra, type WorkflowState } from './tasks.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const tasks = workflowTasks({
  env: requireEnv('HEARTH_ENV'),
  store: createServersStore(requireEnv('SERVERS_TABLE')),
  ec2: sdkEc2(),
  gameInfra: JSON.parse(process.env.GAME_INFRA ?? '{}') as GameInfra,
});

type TaskName = keyof typeof tasks;

/** The state machine invokes `{ task, input }`; the result becomes the next step's input. */
function dispatcher(allowed: readonly TaskName[]) {
  return async ({ task, input }: { task: TaskName; input: WorkflowState }) => {
    if (!allowed.includes(task)) throw new Error(`This function doesn't run ${task}`);
    return tasks[task](input);
  };
}

export const launchHandler = dispatcher(['launchInstance', 'recordVolume']);
export const powerHandler = dispatcher(['startInstance', 'stopInstance', 'waitForStopped']);
export const statusHandler = dispatcher(['waitForAgent', 'markRunning', 'markStopped', 'markFailed']);
