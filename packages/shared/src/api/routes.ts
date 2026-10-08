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
  ListServersQuerySchema,
  ListServersResponseSchema,
  RestoreDoneReportSchema,
  RestoreRequestSchema,
  ServerOperationResultSchema,
  ServerRecordSchema,
  SetVersionRequestSchema,
  UpdateSettingsRequestSchema,
  UploadStatusSchema,
} from './schemas.js';

// Every route the API serves, in one list: the CDK creates the API's routes from it (a route can't
// exist without its entry here), and openapi.json is generated from it.

/** The Lambda that serves a route (ApiStack maps each name to its function). */
export type RouteHandler =
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
  /** A signed-in user (Cognito), allowed by their role on the server for this action. */
  | { kind: 'user'; action: ServerAction };

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
  responses: Partial<Record<200 | 201 | 202 | 204 | 404 | 409, RouteResponse>>;
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
