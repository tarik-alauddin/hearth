import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { UsersStore } from '@hearth/core';
import type {
  ListInvitesResponse,
  ListMyServersResponse,
  MeResponse,
  ServerBackupsResponse,
  ServerOperationResult,
  ServerRecord,
} from '@hearth/shared';
import { AccessDenied, toServerView } from '../authz.js';
import { OperationError, type serverOperations } from '../servers/operations.js';
import type { inviteOperations } from '../invites/operations.js';
import type { userOperations } from '../users/operations.js';
import { callerFromClaims, type Claims } from './claims.js';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

export interface UserHandlerDeps {
  users: Pick<UsersStore, 'recordSignIn'>;
  userOps: ReturnType<typeof userOperations>;
  inviteOps: ReturnType<typeof inviteOperations>;
  serverOps: Pick<
    ReturnType<typeof serverOperations>,
    | 'relationTo'
    | 'getServer'
    | 'listMyServers'
    | 'createServer'
    | 'startServer'
    | 'stopServer'
    | 'destroyServer'
    | 'updateSettings'
    | 'setVersion'
    | 'listBackups'
    | 'requestRestore'
    | 'cancelRestore'
  >;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * One Lambda for every /v1 route (signed-in users; API Gateway checks their Cognito ID token),
 * dispatched by route key. Routes say who is calling; the operations decide what they may do.
 */
export function userHandler({ users, userOps, serverOps, inviteOps, now = () => new Date(), log = defaultLog }: UserHandlerDeps) {
  return async function handle(event: Event): Promise<Result> {
    const caller = callerFromClaims(event.requestContext.authorizer?.jwt?.claims as Claims | undefined);
    if (!caller) return json(401, { message: 'Send the ID token from signing in (Authorization: Bearer <id token>)' });

    /** A changed server, as the caller sees it (their role read again: the operation checked a stronger one). */
    const changed = async (what: string, server: ServerRecord): Promise<Result> => {
      log({ msg: what, by: caller.userId, serverId: server.serverId });
      return json(200, toServerView(server, await serverOps.relationTo(caller.actor, server.serverId)));
    };

    /** 202 when a workflow started; 200 when the server was already there (`unchanged`). */
    const lifecycle = (what: string, result: ServerOperationResult): Result => {
      log({ msg: `${what} requested`, by: caller.userId, ...result });
      return json(result.unchanged ? 200 : 202, result);
    };

    try {
      switch (event.routeKey) {
        case 'GET /v1/me': {
          // Every visit refreshes the profile; the first one creates the user, not yet approved.
          const user = await users.recordSignIn(caller.userId, caller.profile, now());
          if (user.createdAt === user.lastSeenAt) log({ msg: 'new user', userId: caller.userId, provider: user.provider });
          const body: MeResponse = {
            userId: user.userId,
            admin: caller.admin,
            approved: user.approved,
            serverLimit: user.serverLimit,
            createdAt: user.createdAt,
            ...pick(user, ['provider', 'email', 'name', 'username', 'displayName', 'picture']),
          };
          return json(200, body);
        }
        case 'GET /v1/servers': {
          const mine = await serverOps.listMyServers(caller.actor, event.queryStringParameters?.all === 'true');
          const body: ListMyServersResponse = { servers: mine.map(({ server, relation }) => toServerView(server, relation)) };
          return json(200, body);
        }
        case 'POST /v1/servers': {
          const result = await serverOps.createServer(caller.actor, parseBody(event));
          log({ msg: 'server created', by: caller.userId, ...result });
          return json(202, result);
        }
        case 'POST /v1/servers/{id}/start':
          return lifecycle('start', await serverOps.startServer(caller.actor, serverId(event)));
        case 'POST /v1/servers/{id}/stop':
          return lifecycle('stop', await serverOps.stopServer(caller.actor, serverId(event)));
        case 'POST /v1/servers/{id}/destroy':
          return lifecycle('destroy', await serverOps.destroyServer(caller.actor, serverId(event)));
        case 'PATCH /v1/servers/{id}':
          return changed('settings changed', await serverOps.updateSettings(caller.actor, serverId(event), parseBody(event)));
        case 'POST /v1/servers/{id}/version':
          return changed('version set', await serverOps.setVersion(caller.actor, serverId(event), parseBody(event)));
        case 'POST /v1/servers/{id}/restore':
          return changed('restore requested', await serverOps.requestRestore(caller.actor, serverId(event), parseBody(event)));
        case 'DELETE /v1/servers/{id}/restore':
          return changed('restore cancelled', await serverOps.cancelRestore(caller.actor, serverId(event)));
        case 'POST /v1/servers/{id}/invites': {
          const invite = await inviteOps.createInvite(caller.actor, serverId(event));
          log({ msg: 'invite created', by: caller.userId, serverId: serverId(event), expiresAt: invite.expiresAt });
          return json(201, invite);
        }
        case 'GET /v1/servers/{id}/invites': {
          const body: ListInvitesResponse = { invites: await inviteOps.listInvites(caller.actor, serverId(event)) };
          return json(200, body);
        }
        case 'DELETE /v1/servers/{id}/invites/{code}': {
          await inviteOps.revokeInvite(caller.actor, serverId(event), event.pathParameters?.code ?? '');
          log({ msg: 'invite revoked', by: caller.userId, serverId: serverId(event) });
          return { statusCode: 204 };
        }
        case 'POST /v1/invites/{code}/accept': {
          const { server, relation } = await inviteOps.acceptInvite(caller.actor, event.pathParameters?.code ?? '');
          log({ msg: 'invite accepted', by: caller.userId, serverId: server.serverId, role: relation });
          return json(200, toServerView(server, relation));
        }
        case 'GET /v1/servers/{id}/backups': {
          const { backups } = await serverOps.listBackups(caller.actor, serverId(event));
          const body: ServerBackupsResponse = {
            // The file name, not the storage key: what a restore takes.
            backups: backups.map(({ key, takenAt, bytes }) => ({ id: key.slice(key.lastIndexOf('/') + 1), takenAt, bytes })),
          };
          return json(200, body);
        }
        case 'GET /v1/servers/{id}': {
          const { server, relation } = await serverOps.getServer(caller.actor, event.pathParameters?.id ?? '');
          return json(200, toServerView(server, relation));
        }
        case 'POST /v1/admin/users/{id}/approval': {
          const userId = event.pathParameters?.id ?? '';
          const user = await userOps.setApproval(caller.actor, userId, parseBody(event));
          log({ msg: 'user approval set', by: caller.userId, userId, approved: user.approved });
          return json(200, user);
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

function serverId(event: Event): string {
  return event.pathParameters?.id ?? '';
}

function parseBody(event: Event): unknown {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    return JSON.parse(raw ?? '');
  } catch {
    throw new OperationError(400, 'Body must be JSON');
  }
}

function pick<T extends object, K extends keyof T>(from: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter((key) => from[key] !== undefined).map((key) => [key, from[key]])) as Partial<Pick<T, K>>;
}

function json(statusCode: number, body: unknown): Result {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function defaultLog(entry: Record<string, unknown>) {
  console.log(JSON.stringify(entry));
}
