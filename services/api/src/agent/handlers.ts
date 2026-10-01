import type {
  APIGatewayProxyEventV2WithIAMAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import {
  DEFAULT_AGENT_CHANNEL,
  GAME_DEFINITIONS,
  isAgentState,
  type AgentConfig,
  type AgentStatusReport,
  type ServerRecord,
} from '@hearth/shared';
import type { ServersStore } from '@hearth/core';
import { callerInstanceId } from './caller.js';
import type { AgentReleases } from './releases.js';

type Event = APIGatewayProxyEventV2WithIAMAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

interface Caller {
  instanceId: string;
  server: ServerRecord;
}

export interface AgentHandlerDeps {
  store: Pick<ServersStore, 'findByInstance' | 'recordAgentReport'>;
  /** Names of the game instance roles allowed to call agent routes. */
  instanceRoleNames: readonly string[];
  /** Which agent release each channel points at. */
  releases: AgentReleases;
  now?: () => Date;
}

const MAX_VERSION_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 500;

export function agentHandlers({ store, instanceRoleNames, releases, now = () => new Date() }: AgentHandlerDeps) {
  /** Resolves the calling instance's server, or the error response to send instead. */
  async function callerServer(event: Event): Promise<Caller | { error: Result }> {
    const instanceId = callerInstanceId(event.requestContext.authorizer.iam.userArn, instanceRoleNames);
    if (!instanceId) return { error: json(403, { message: 'Caller is not a game instance' }) };
    const server = await store.findByInstance(instanceId);
    if (!server) return { error: json(404, { message: `No server is assigned to instance ${instanceId}` }) };
    return { instanceId, server };
  }

  /** GET /agent/config */
  async function config(event: Event): Promise<Result> {
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { server } = caller;
    const game = GAME_DEFINITIONS[server.game];
    const agent = await releases.target(server.agentChannel ?? DEFAULT_AGENT_CHANNEL);
    const body: AgentConfig = {
      serverId: server.serverId,
      game: server.game,
      version: server.version,
      image: game.image,
      port: game.port,
      ...(agent ? { agent } : {}),
    };
    return json(200, body);
  }

  /** POST /agent/status */
  async function status(event: Event): Promise<Result> {
    const report = parseStatusReport(event);
    if (typeof report === 'string') return json(400, { message: report });
    const caller = await callerServer(event);
    if ('error' in caller) return caller.error;
    const { instanceId, server } = caller;
    if (!(await store.recordAgentReport(server.serverId, instanceId, report, now()))) {
      return json(409, { message: `Server ${server.serverId} is no longer on instance ${instanceId}` });
    }
    console.log(JSON.stringify({ msg: 'agent status', serverId: server.serverId, instanceId, ...report }));
    return { statusCode: 204 };
  }

  return { config, status };
}

/** The validated report, or an error message. */
function parseStatusReport(event: Event): AgentStatusReport | string {
  let body: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw ?? '');
  } catch {
    return 'Body must be JSON';
  }
  if (typeof body !== 'object' || body === null) return 'Body must be a JSON object';
  const { state, agentVersion, message } = body as Record<string, unknown>;
  if (!isAgentState(state)) return 'Invalid state';
  if (typeof agentVersion !== 'string' || !agentVersion || agentVersion.length > MAX_VERSION_LENGTH) {
    return 'Invalid agentVersion';
  }
  if (message !== undefined && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) {
    return 'Invalid message';
  }
  return message === undefined ? { state, agentVersion } : { state, agentVersion, message };
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
