import type { z } from 'zod';
import type { ServerAction } from '../permissions.js';
import {
  AgentConfigSchema,
  AgentStatusReportSchema,
  BackupDoneReportSchema,
  BackupTargetSchema,
  CreateServerRequestSchema,
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  IdleReportSchema,
  InviteSchema,
  ListBackupsResponseSchema,
  ListInvitesResponseSchema,
  ListMyServersResponseSchema,
  ListServersQuerySchema,
  ListServersResponseSchema,
  MeResponseSchema,
  MyServersQuerySchema,
  RestoreDoneReportSchema,
  RestoreRequestSchema,
  ServerBackupsResponseSchema,
  ServerOperationResultSchema,
  ServerRecordSchema,
  ServerViewSchema,
  SetApprovalRequestSchema,
  SetVersionRequestSchema,
  UpdateSettingsRequestSchema,
  UploadStatusSchema,
  UserRecordSchema,
} from './schemas.js';

// Every route the API serves, in one list: the CDK creates the API's routes from it (a route can't
// exist without its entry here), and openapi.json is generated from it.

/** The Lambda that serves a route (ApiStack maps each name to its function). */
export type RouteHandler =
  | 'user'
  | 'admin'
  | 'agentConfig'
  | 'agentStatus'
  | 'agentBackupCredentials'
  | 'agentBackupDone'
  | 'agentRestored'
  | 'agentIdle';

/** Who may call a route. Routes only say who; the operations check what (see authz.ts). */
export type RouteCaller =
  /** Hearth admins (today: IAM, the owner's own AWS credentials). */
  | { kind: 'admin' }
  /** A game instance's agent (IAM, its instance role), about its own server. */
  | { kind: 'agent' }
  /**
   * A signed-in user (Cognito ID token). For a route about one server, `action` is what their role
   * on it must allow (SERVER_PERMISSIONS); routes about the caller themselves have none.
   * `adminOnly`: platform-wide actions, for members of the `admin` group alone (`requireAdmin`).
   */
  | { kind: 'user'; action?: ServerAction; adminOnly?: true };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RouteResponse {
  description: string;
  schema?: z.ZodType;
}

export interface ApiRoute {
  /** Unique; the OpenAPI operationId. */
  id: string;
  method: HttpMethod;
  /** API Gateway path syntax: `{id}` for a path parameter. */
  path: string;
  handler: RouteHandler;
  caller: RouteCaller;
  summary: string;
  description?: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success responses, and any error worth explaining beyond the usual 400, 403 and 404. */
  responses: Partial<Record<200 | 201 | 202 | 204 | 403 | 404 | 409, RouteResponse>>;
}

const operation = {
  202: { description: 'The workflow started', schema: ServerOperationResultSchema },
  200: { description: 'Nothing to do: the server was already there (`unchanged`)', schema: ServerOperationResultSchema },
} as const;
const server = (description: string) => ({ description, schema: ServerRecordSchema });
const conflict = (description: string) => ({ description });

const admin = { kind: 'admin' } as const;
const agent = { kind: 'agent' } as const;

export const API_ROUTES: readonly ApiRoute[] = [
  // Routes for signed-in users (the web app; the CLI from M8 PR7).
  {
    id: 'getMe',
    method: 'GET',
    path: '/v1/me',
    handler: 'user',
    caller: { kind: 'user' },
    summary: 'Who I am',
    description: 'Also records the user on first sight (not yet approved) and refreshes their profile from the token.',
    responses: { 200: { description: 'The caller', schema: MeResponseSchema } },
  },
  {
    id: 'listMyServers',
    method: 'GET',
    path: '/v1/servers',
    handler: 'user',
    caller: { kind: 'user' },
    summary: 'My servers',
    description: 'The servers the caller owns or is a member of, newest first. Destroyed ones only with `all=true`.',
    query: MyServersQuerySchema,
    responses: { 200: { description: 'The servers, as the caller sees them', schema: ListMyServersResponseSchema } },
  },
  {
    id: 'createServer',
    method: 'POST',
    path: '/v1/servers',
    handler: 'user',
    caller: { kind: 'user' },
    summary: 'Create a server',
    description:
      'Records it (PROVISIONING), owned by the caller, and runs the create workflow, which also starts it. ' +
      "The caller must be approved and under their server limit (destroyed servers don't count); " +
      '`agentChannel` is for admins. Creating from an upload comes with the /v1 uploads.',
    body: CreateServerRequestSchema,
    responses: {
      202: { description: 'Created; the create workflow is running', schema: ServerOperationResultSchema },
      403: { description: 'Not approved yet, at the server limit, or (not an admin) choosing an agent channel' },
    },
  },
  {
    id: 'getServer',
    method: 'GET',
    path: '/v1/servers/{id}',
    handler: 'user',
    caller: { kind: 'user', action: 'view' },
    summary: 'One of my servers',
    description: 'Its status, and the address players join while it runs.',
    responses: { 200: { description: 'The server, as the caller sees it', schema: ServerViewSchema } },
  },
  {
    id: 'startServer',
    method: 'POST',
    path: '/v1/servers/{id}/start',
    handler: 'user',
    caller: { kind: 'user', action: 'start' },
    summary: 'Start a server',
    description: 'Owners and members. Players can join once it is RUNNING, at its `address`.',
    responses: { ...operation, 409: conflict("It's in a state that can't be started") },
  },
  {
    id: 'stopServer',
    method: 'POST',
    path: '/v1/servers/{id}/stop',
    handler: 'user',
    caller: { kind: 'user', action: 'stop' },
    summary: 'Stop a server (saving and backing it up)',
    description: 'Owners and members.',
    responses: { ...operation, 409: conflict("It's in a state that can't be stopped") },
  },
  {
    id: 'destroyServer',
    method: 'POST',
    path: '/v1/servers/{id}/destroy',
    handler: 'user',
    caller: { kind: 'user', action: 'destroy' },
    summary: "Destroy a stopped server's instance and data volume",
    description: "Owners only. Its backups are kept, and it no longer counts toward the owner's server limit.",
    responses: { ...operation, 409: conflict('Not stopped: stop it first') },
  },
  {
    id: 'updateServerSettings',
    method: 'PATCH',
    path: '/v1/servers/{id}',
    handler: 'user',
    caller: { kind: 'user', action: 'settings' },
    summary: "Change a server's settings",
    description: 'Owners. `idleStopMinutes` (0 = never); `agentChannel` is for admins. They apply from the next start.',
    body: UpdateSettingsRequestSchema,
    responses: { 200: { description: 'The server, with its new settings', schema: ServerViewSchema }, 409: conflict("It's destroyed") },
  },
  {
    id: 'setServerVersion',
    method: 'POST',
    path: '/v1/servers/{id}/version',
    handler: 'user',
    caller: { kind: 'user', action: 'version' },
    summary: 'Move a stopped server to a newer game version',
    description: 'Owners. From its next start; forward only, and only after a clean stop with a backup since it last ran.',
    body: SetVersionRequestSchema,
    responses: {
      200: { description: 'The server, with its new version', schema: ServerViewSchema },
      409: conflict('Not stopped, not newer, or no backup since it last ran'),
    },
  },
  {
    id: 'listServerBackups',
    method: 'GET',
    path: '/v1/servers/{id}/backups',
    handler: 'user',
    caller: { kind: 'user', action: 'backups' },
    summary: "A server's backups",
    description: 'Owners. Newest first; each `id` is what a restore takes.',
    responses: { 200: { description: 'Its backups', schema: ServerBackupsResponseSchema } },
  },
  {
    id: 'requestServerRestore',
    method: 'POST',
    path: '/v1/servers/{id}/restore',
    handler: 'user',
    caller: { kind: 'user', action: 'restore' },
    summary: 'Restore a backup on the next start',
    description:
      'Owners. `key`: a backup `id` from its list (default the newest). Refused after an unclean last stop unless `force` ' +
      '(the current game data may be in no backup).',
    body: RestoreRequestSchema,
    responses: {
      200: { description: 'The server, with the restore pending', schema: ServerViewSchema },
      404: { description: 'No such server, or no such backup of it' },
      409: conflict('Not stopped, no backups, or an unclean last stop (unless forced)'),
    },
  },
  {
    id: 'cancelServerRestore',
    method: 'DELETE',
    path: '/v1/servers/{id}/restore',
    handler: 'user',
    caller: { kind: 'user', action: 'restore' },
    summary: 'Cancel a pending restore',
    description: 'Owners. Only while stopped: once it starts, the restore may be under way.',
    responses: { 200: { description: 'The server, with no restore pending', schema: ServerViewSchema }, 409: conflict('No longer stopped') },
  },
  {
    id: 'createInvite',
    method: 'POST',
    path: '/v1/servers/{id}/invites',
    handler: 'user',
    caller: { kind: 'user', action: 'invite' },
    summary: 'Invite friends to a server',
    description: 'Owners. A code anyone signed in can accept within 7 days, as many times as it is shared; revoke it to stop that.',
    responses: {
      201: { description: 'The invite', schema: InviteSchema },
      409: conflict("It's destroyed"),
    },
  },
  {
    id: 'listInvites',
    method: 'GET',
    path: '/v1/servers/{id}/invites',
    handler: 'user',
    caller: { kind: 'user', action: 'invite' },
    summary: "A server's invites",
    description: 'Owners. The unexpired ones, newest first.',
    responses: { 200: { description: 'Its invites', schema: ListInvitesResponseSchema } },
  },
  {
    id: 'revokeInvite',
    method: 'DELETE',
    path: '/v1/servers/{id}/invites/{code}',
    handler: 'user',
    caller: { kind: 'user', action: 'invite' },
    summary: 'Revoke an invite',
    description: 'Owners. Members who already accepted it keep their access (remove them separately).',
    responses: { 204: { description: 'Revoked' }, 404: { description: 'No such server, or no such invite to it' } },
  },
  {
    id: 'acceptInvite',
    method: 'POST',
    path: '/v1/invites/{code}/accept',
    handler: 'user',
    caller: { kind: 'user' },
    summary: 'Join a server with an invite',
    description:
      'Any signed-in user, no approval needed. Makes the caller a member (see it, start and stop it); ' +
      'someone who already has access keeps their role.',
    responses: {
      200: { description: 'The server, as the caller now sees it', schema: ServerViewSchema },
      404: { description: 'No such invite: wrong, expired or revoked, or its server is destroyed' },
    },
  },
  {
    id: 'setUserApproval',
    method: 'POST',
    path: '/v1/admin/users/{id}/approval',
    handler: 'user',
    caller: { kind: 'user', adminOnly: true },
    summary: 'Approve a user (or take approval back)',
    description:
      'Approved users may create servers. `{id}` is their user ID (`userId` from `/v1/me`, their Cognito sub); ' +
      'one person signed in with several providers is several users, each approved on its own.',
    body: SetApprovalRequestSchema,
    responses: {
      200: { description: 'The user, with their approval', schema: UserRecordSchema },
      404: { description: 'No such user: they sign in once first' },
    },
  },

  // Admin routes (the hearth CLI).
  {
    id: 'adminListServers',
    method: 'GET',
    path: '/admin/servers',
    handler: 'admin',
    caller: admin,
    summary: 'List every server',
    description: 'Destroyed servers only with `all=true`; a page can then be short, so follow the cursor.',
    query: ListServersQuerySchema,
    responses: { 200: { description: 'One page of servers', schema: ListServersResponseSchema } },
  },
  {
    id: 'adminCreateServer',
    method: 'POST',
    path: '/admin/servers',
    handler: 'admin',
    caller: admin,
    summary: 'Create a server',
    description: 'Records it (PROVISIONING) and runs the create workflow, which also starts it.',
    body: CreateServerRequestSchema,
    responses: {
      202: { description: 'Created; the create workflow is running', schema: ServerOperationResultSchema },
      404: { description: 'No such upload (never uploaded, or expired)' },
      409: conflict('The upload is still being checked, was rejected, or is for another game'),
    },
  },
  {
    id: 'adminGetServer',
    method: 'GET',
    path: '/admin/servers/{id}',
    handler: 'admin',
    caller: admin,
    summary: 'Get a server',
    responses: { 200: server('The server') },
  },
  {
    id: 'adminListBackups',
    method: 'GET',
    path: '/admin/servers/{id}/backups',
    handler: 'admin',
    caller: admin,
    summary: "List a server's backups",
    responses: { 200: { description: 'Newest first', schema: ListBackupsResponseSchema } },
  },
  {
    id: 'adminSetVersion',
    method: 'POST',
    path: '/admin/servers/{id}/version',
    handler: 'admin',
    caller: admin,
    summary: 'Move a stopped server to a newer game version',
    description: 'From its next start. Forward only, and only after a clean stop with a backup.',
    body: SetVersionRequestSchema,
    responses: { 200: server('The server, with its new version'), 409: conflict('Not stopped, not newer, or no backup since it last ran') },
  },
  {
    id: 'adminRequestRestore',
    method: 'POST',
    path: '/admin/servers/{id}/restore',
    handler: 'admin',
    caller: admin,
    summary: 'Restore a backup on the next start',
    body: RestoreRequestSchema,
    responses: { 200: server('The server, with the restore pending'), 409: conflict("Not stopped, no backups, or an unclean last stop (unless forced)") },
  },
  {
    id: 'adminCancelRestore',
    method: 'POST',
    path: '/admin/servers/{id}/restore/cancel',
    handler: 'admin',
    caller: admin,
    summary: 'Cancel a pending restore',
    responses: { 200: server('The server, with no restore pending'), 409: conflict('No longer stopped') },
  },
  {
    id: 'adminStartServer',
    method: 'POST',
    path: '/admin/servers/{id}/start',
    handler: 'admin',
    caller: admin,
    summary: 'Start a server',
    responses: { ...operation, 409: conflict("It's in a state that can't be started") },
  },
  {
    id: 'adminStopServer',
    method: 'POST',
    path: '/admin/servers/{id}/stop',
    handler: 'admin',
    caller: admin,
    summary: 'Stop a server (saving and backing it up)',
    responses: { ...operation, 409: conflict("It's in a state that can't be stopped") },
  },
  {
    id: 'adminDestroyServer',
    method: 'POST',
    path: '/admin/servers/{id}/destroy',
    handler: 'admin',
    caller: admin,
    summary: "Destroy a stopped server's instance and data volume",
    description: 'Its backups and record are kept; the record is marked DESTROYED.',
    responses: { ...operation, 409: conflict('Not stopped: stop it first') },
  },
  {
    id: 'adminUpdateSettings',
    method: 'POST',
    path: '/admin/servers/{id}/settings',
    handler: 'admin',
    caller: admin,
    summary: "Change a server's settings",
    body: UpdateSettingsRequestSchema,
    responses: { 200: server('The server, with its new settings'), 409: conflict("It's destroyed") },
  },
  {
    id: 'adminCreateUpload',
    method: 'POST',
    path: '/admin/uploads',
    handler: 'admin',
    caller: admin,
    summary: 'Start an upload of game data',
    body: CreateUploadRequestSchema,
    responses: { 201: { description: 'A form to upload the file with', schema: CreateUploadResponseSchema } },
  },
  {
    id: 'adminGetUpload',
    method: 'GET',
    path: '/admin/uploads/{id}',
    handler: 'admin',
    caller: admin,
    summary: 'How the check of an upload is going',
    responses: { 200: { description: 'Repacking, accepted or rejected', schema: UploadStatusSchema } },
  },

  // Agent routes (game instances, about their own server).
  {
    id: 'agentGetConfig',
    method: 'GET',
    path: '/agent/config',
    handler: 'agentConfig',
    caller: agent,
    summary: "The instance's server: what to run, and any pending restore",
    responses: { 200: { description: 'The config', schema: AgentConfigSchema } },
  },
  {
    id: 'agentReportStatus',
    method: 'POST',
    path: '/agent/status',
    handler: 'agentStatus',
    caller: agent,
    summary: "Report the game's state",
    body: AgentStatusReportSchema,
    responses: { 204: { description: 'Recorded' }, 409: conflict('The server is no longer on this instance') },
  },
  {
    id: 'agentBackupCredentials',
    method: 'POST',
    path: '/agent/backup-credentials',
    handler: 'agentBackupCredentials',
    caller: agent,
    summary: 'Where to upload a new backup, with credentials for that key only',
    responses: { 200: { description: 'The upload target', schema: BackupTargetSchema } },
  },
  {
    id: 'agentBackupDone',
    method: 'POST',
    path: '/agent/backups',
    handler: 'agentBackupDone',
    caller: agent,
    summary: 'A backup finished uploading: record it, and prune old ones',
    body: BackupDoneReportSchema,
    responses: { 204: { description: 'Recorded' }, 409: conflict('The server is no longer on this instance') },
  },
  {
    id: 'agentRestoreDone',
    method: 'POST',
    path: '/agent/restored',
    handler: 'agentRestored',
    caller: agent,
    summary: 'The requested restore is done: clear it',
    body: RestoreDoneReportSchema,
    responses: { 204: { description: 'Cleared' }, 409: conflict('No restore of that key is pending') },
  },
  {
    id: 'agentIdleStop',
    method: 'POST',
    path: '/agent/idle',
    handler: 'agentIdle',
    caller: agent,
    summary: 'Nobody is playing: stop the server through the stop workflow',
    body: IdleReportSchema,
    responses: { ...operation, 409: conflict("Not running, or no longer on this instance") },
  },
];
