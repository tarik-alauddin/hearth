import type {
  APIGatewayProxyEventV2WithIAMAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { ListServersResponse } from '@hearth/shared';
import { callerInstanceId } from '../agent/caller.js';
import { OperationError, type serverOperations } from '../servers/operations.js';
import type { uploadOperations } from '../uploads.js';

type Event = APIGatewayProxyEventV2WithIAMAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

export interface AdminHandlerDeps {
  operations: ReturnType<typeof serverOperations>;
  uploads: ReturnType<typeof uploadOperations>;
  /** Game instances must never use admin routes, even if IAM were misconfigured. */
  instanceRoleNames: readonly string[];
  log?: (entry: Record<string, unknown>) => void;
}

/** One Lambda for every /admin route (IAM auth), dispatched by route key. */
export function adminHandler({ operations, uploads, instanceRoleNames, log = defaultLog }: AdminHandlerDeps) {
  return async function handle(event: Event): Promise<Result> {
    const caller = event.requestContext.authorizer.iam.userArn;
    if (callerInstanceId(caller, instanceRoleNames)) return json(403, { message: 'Game instances cannot use admin routes' });
    const serverId = event.pathParameters?.id ?? '';

    try {
      switch (event.routeKey) {
        case 'GET /admin/servers': {
          const query = event.queryStringParameters ?? {};
          const body: ListServersResponse = await operations.listServers(query.limit, query.cursor);
          return json(200, body);
        }
        case 'POST /admin/servers': {
          const result = await operations.createServer(parseBody(event), caller);
          log({ msg: 'server created', caller, ...result });
          return json(202, result);
        }
        case 'GET /admin/servers/{id}':
          return json(200, await operations.getServer(serverId));
        case 'POST /admin/uploads': {
          const result = await uploads.createUpload(parseBody(event));
          log({ msg: 'upload started', caller, uploadId: result.uploadId });
          return json(201, result);
        }
        case 'GET /admin/uploads/{id}':
          return json(200, await uploads.uploadStatus(event.pathParameters?.id ?? ''));
        case 'GET /admin/servers/{id}/backups':
          return json(200, await operations.listBackups(serverId));
        case 'POST /admin/servers/{id}/version': {
          const server = await operations.setVersion(serverId, parseBody(event));
          log({ msg: 'version set', caller, serverId, version: server.version });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/restore': {
          const server = await operations.requestRestore(serverId, parseBody(event));
          log({ msg: 'restore requested', caller, serverId, key: server.restoreKey });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/restore/cancel': {
          const server = await operations.cancelRestore(serverId);
          log({ msg: 'restore cancelled', caller, serverId });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/start': {
          const result = await operations.startServer(serverId);
          log({ msg: 'start requested', caller, ...result });
          return json(result.unchanged ? 200 : 202, result);
        }
        case 'POST /admin/servers/{id}/settings': {
          const server = await operations.updateSettings(serverId, parseBody(event));
          log({ msg: 'settings changed', caller, serverId, agentChannel: server.agentChannel });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/stop': {
          const result = await operations.stopServer(serverId);
          log({ msg: 'stop requested', caller, ...result });
          return json(result.unchanged ? 200 : 202, result);
        }
        default:
          return json(404, { message: `No route ${event.routeKey}` });
      }
    } catch (err) {
      if (err instanceof OperationError) return json(err.statusCode, { message: err.message });
      throw err;
    }
  };
}

function parseBody(event: Event): unknown {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    return JSON.parse(raw ?? '');
  } catch {
    throw new OperationError(400, 'Body must be JSON');
  }
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function defaultLog(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}
