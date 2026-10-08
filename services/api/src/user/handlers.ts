import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { UsersStore } from '@hearth/core';
import type { MeResponse } from '@hearth/shared';
import { AccessDenied } from '../authz.js';
import { OperationError } from '../servers/operations.js';
import type { userOperations } from '../users/operations.js';
import { callerFromClaims, type Claims } from './claims.js';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;
type Result = APIGatewayProxyStructuredResultV2;

export interface UserHandlerDeps {
  users: Pick<UsersStore, 'recordSignIn'>;
  userOps: ReturnType<typeof userOperations>;
  now?: () => Date;
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * One Lambda for every /v1 route (signed-in users; API Gateway checks their Cognito ID token),
 * dispatched by route key. Routes say who is calling; the operations decide what they may do.
 */
export function userHandler({ users, userOps, now = () => new Date(), log = defaultLog }: UserHandlerDeps) {
  return async function handle(event: Event): Promise<Result> {
    const caller = callerFromClaims(event.requestContext.authorizer?.jwt?.claims as Claims | undefined);
    if (!caller) return json(401, { message: 'Send the ID token from signing in (Authorization: Bearer <id token>)' });

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
