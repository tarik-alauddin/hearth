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
  ListBackupsResponseSchema,
  ListMyServersResponseSchema,
  ListServersQuerySchema,
  ListServersResponseSchema,
  MeResponseSchema,
  MyServersQuerySchema,
  RestoreDoneReportSchema,
  RestoreRequestSchema,
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
