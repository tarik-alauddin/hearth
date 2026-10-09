import type {
  APIGatewayProxyEventV2WithIAMAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { ListServersResponse } from '@hearth/shared';
import { callerInstanceId } from '../agent/caller.js';
import { AccessDenied, shapeServer, type Actor } from '../authz.js';
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
    // Every /admin caller is a Hearth admin: IAM only lets the owner's credentials in.
    const actor: Actor = { kind: 'admin', id: caller };
    const serverId = event.pathParameters?.id ?? '';

    try {
      switch (event.routeKey) {
        case 'GET /admin/servers': {
          const query = event.queryStringParameters ?? {};
          const body: ListServersResponse = await operations.listServers(actor, query.limit, query.cursor, query.all === 'true');
          return json(200, body);
        }
        case 'POST /admin/servers': {
          const result = await operations.createServer(actor, parseBody(event));
          log({ msg: 'server created', caller, ...result });
          return json(202, result);
        }
        case 'GET /admin/servers/{id}': {
          const { server, relation } = await operations.getServer(actor, serverId);
          return json(200, shapeServer(server, relation));
        }
        case 'POST /admin/uploads': {
          const result = await uploads.createUpload(actor, parseBody(event));
          log({ msg: 'upload started', caller, uploadId: result.uploadId });
          return json(201, result);
        }
        case 'GET /admin/uploads/{id}':
          return json(200, await uploads.uploadStatus(actor, event.pathParameters?.id ?? ''));
        case 'GET /admin/servers/{id}/backups':
          return json(200, await operations.listBackups(actor, serverId));
        case 'POST /admin/servers/{id}/version': {
          const server = await operations.setVersion(actor, serverId, parseBody(event));
          log({ msg: 'version set', caller, serverId, version: server.version });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/restore': {
          const server = await operations.requestRestore(actor, serverId, parseBody(event));
          log({ msg: 'restore requested', caller, serverId, key: server.restoreKey });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/restore/cancel': {
          const server = await operations.cancelRestore(actor, serverId);
          log({ msg: 'restore cancelled', caller, serverId });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/start': {
          const result = await operations.startServer(actor, serverId);
          log({ msg: 'start requested', caller, ...result });
          return json(result.unchanged ? 200 : 202, result);
        }
        case 'POST /admin/servers/{id}/settings': {
          const server = await operations.updateSettings(actor, serverId, parseBody(event));
          log({ msg: 'settings changed', caller, serverId, agentChannel: server.agentChannel });
          return json(200, server);
        }
        case 'POST /admin/servers/{id}/stop': {
          const result = await operations.stopServer(actor, serverId);
          log({ msg: 'stop requested', caller, ...result });
          return json(result.unchanged ? 200 : 202, result);
        }
        case 'POST /admin/servers/{id}/destroy': {
          const result = await operations.destroyServer(actor, serverId);
          log({ msg: 'destroy requested', caller, ...result });
          return json(result.unchanged ? 200 : 202, result);
        }
        default:
          return json(404, { message: `No route ${event.routeKey}` });
      }
    } catch (err) {
      if (err instanceof OperationError || err instanceof AccessDenied) return json(err.statusCode, { message: err.message });
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
