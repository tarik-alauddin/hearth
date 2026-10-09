// A namespace import: unlike `import { z }`, it lets bundlers drop the parts of Zod the Lambdas
// don't use (all its translated messages, among others): about 80 KB instead of 440 KB.
import * as z from 'zod';
import { AGENT_STATES } from '../agent-api.js';
import { AGENT_CHANNELS } from '../agent-releases.js';
import { GAMES } from '../games.js';
import { INSTANCE_STATES, MAX_IDLE_STOP_MINUTES, SERVER_STATUSES } from '../server.js';

// The API's request and response bodies: one definition each, which checks requests at runtime,
// gives the TypeScript types (same names as before), and documents the API (openapi.json).
// Imported as `@hearth/shared/api`, so only code that checks requests or builds the docs loads
// Zod; everything else imports the types alone, from `@hearth/shared`.

interface SchemaMeta {
  id: string;
  description?: string;
}

/** Every named schema, for the OpenAPI document's components. */
export const apiSchemas = z.registry<SchemaMeta>();

/** Registers `schema` under `id`. (Zod types `add` per schema type; any schema is fine here.) */
function named<T extends z.ZodType>(schema: T, id: string, description?: string): T {
  (apiSchemas.add as (schema: z.ZodType, meta: SchemaMeta) => unknown)(schema, { id, ...(description ? { description } : {}) });
  return schema;
}

const isoTime = (description: string) => z.string().describe(`${description} (ISO 8601, UTC)`);

/** A game version as the game names it, e.g. `1.21.4` or `26.3`. */
export const GAME_VERSION = /^[0-9A-Za-z._-]{1,32}$/;
const gameVersion = z.string().regex(GAME_VERSION, 'must be a game version, e.g. 1.21.4');

// Enums.
export const GameIdSchema = named(z.enum(GAMES), 'GameId', 'A game Hearth runs.');
export const AgentChannelSchema = named(z.enum(AGENT_CHANNELS), 'AgentChannel', 'Which agent releases a server follows.');
export const ServerStatusSchema = named(z.enum(SERVER_STATUSES), 'ServerStatus');
export const AgentStateSchema = named(z.enum(AGENT_STATES), 'AgentState', 'What the agent says the game is doing.');
export const InstanceStateSchema = named(z.enum(INSTANCE_STATES), 'InstanceState', "EC2's state of the instance.");
const ServerRelationSchema = named(
  z.enum(['owner', 'member', 'admin']),
  'ServerRelation',
  "What the caller is to a server: its owner, a member, or an admin (who reaches every server).",
);

export const ErrorResponseSchema = named(
  z.object({ message: z.string().describe('What went wrong, for people') }),
  'ErrorResponse',
  'Every error response.',
);

// Servers.

export const ServerRecordSchema = named(
  z.object({
    serverId: z.string().describe('ULID'),
    ownerId: z.string().describe("The owner's id: a Cognito sub, or an admin's IAM ARN"),
    game: GameIdSchema,
    region: z.string(),
    status: ServerStatusSchema,
    version: z.string().describe('Game version'),
    autoUpdate: z.boolean(),
    agentChannel: AgentChannelSchema.optional().describe('Default stable'),
    idleStopMinutes: z.number().int().optional().describe('Stop after this long with nobody playing; 0 = never; default 30'),
    instanceId: z.string().optional(),
    volumeId: z.string().optional(),
    agentState: AgentStateSchema.optional(),
    agentVersion: z.string().optional(),
    agentReportedAt: isoTime('When the agent last reported').optional(),
    agentMessage: z.string().optional(),
    instanceState: InstanceStateSchema.optional(),
    instanceStateAt: isoTime("The EC2 event's time").optional(),
    publicIp: z.string().optional().describe('Only while running; changes on every start'),
    lastStartedAt: z.string().optional(),
    lastStoppedAt: z.string().optional(),
    createdAt: isoTime('Created').optional(),
    destroyedAt: isoTime('When the destroy workflow finished').optional(),
    statusChangedAt: isoTime('Set by every status change').optional(),
    lastOperationId: z.string().optional().describe('The latest claim; names its workflow execution'),
    statusMessage: z.string().optional().describe('Why the server is FAILED'),
    lastStopClean: z.boolean().optional().describe('The agent reported a clean stop (game saved)'),
    stopReason: z.string().optional().describe('Why the last stop happened, when not asked for'),
    lastBackupKey: z.string().optional(),
    lastBackupAt: isoTime('When the newest backup finished').optional(),
    lastBackupBytes: z.number().int().optional(),
    restoreKey: z.string().optional().describe('A pending restore: replaces the game data on the next start'),
    restoreSource: z.literal('upload').optional().describe('restoreKey is an accepted upload; unset = a backup'),
    restoreRequestedAt: isoTime('When the restore was requested').optional(),
  }),
  'ServerRecord',
  'A server as admins see it: the whole record.',
);

export const ServerViewSchema = named(
  z.object({
    serverId: z.string(),
    role: ServerRelationSchema,
    game: GameIdSchema,
    region: z.string(),
    version: z.string(),
    status: ServerStatusSchema,
    statusMessage: z.string().optional().describe("Why it's FAILED"),
    address: z.string().optional().describe('Where players connect: the public IP, while it runs'),
    gameState: AgentStateSchema.optional().describe('The game inside, while it starts or runs'),
    idleStopMinutes: z.number().int().describe('0 = never'),
    stopReason: z.string().optional(),
    lastStartedAt: z.string().optional(),
    lastStoppedAt: z.string().optional(),
    lastBackupAt: z.string().optional(),
    restorePending: z.boolean().describe('A restore will replace the game data on the next start'),
    createdAt: z.string().optional(),
    destroyedAt: z.string().optional(),
  }),
  'ServerView',
  'A server as an owner or member sees it: no instance IDs, storage keys or agent internals.',
);

export const CreateServerRequestSchema = named(
  z.strictObject({
    game: GameIdSchema,
    version: gameVersion,
    region: z.string().min(1).optional().describe('Defaults to the home region'),
    agentChannel: AgentChannelSchema.optional().describe('Defaults to stable'),
    upload: z.string().min(1).optional().describe('An accepted upload to start with, instead of new game data'),
  }),
  'CreateServerRequest',
);

export const UpdateSettingsRequestSchema = named(
  z
    .strictObject({
      agentChannel: AgentChannelSchema.optional().describe('Admins only'),
      idleStopMinutes: z
        .number()
        .int()
        .min(0)
        .max(MAX_IDLE_STOP_MINUTES)
        .optional()
        .describe(`Stop after this long with nobody playing (1–${MAX_IDLE_STOP_MINUTES}); 0 = never`),
    })
    .refine((s) => s.agentChannel !== undefined || s.idleStopMinutes !== undefined, 'No settings given'),
  'UpdateSettingsRequest',
  'The settings to change; they apply from the next start.',
);

export const SetVersionRequestSchema = named(
  z.strictObject({ version: gameVersion.describe('A newer release of the game') }),
  'SetVersionRequest',
);

export const RestoreRequestSchema = named(
  z.strictObject({
    key: z.string().min(1).optional().describe('A key from the backups list, or its file name; default the newest'),
    force: z.boolean().optional().describe("Restore even though the last stop wasn't clean"),
  }),
  'RestoreRequest',
);

export const ServerOperationResultSchema = named(
  z.object({
    serverId: z.string(),
    status: ServerStatusSchema,
    unchanged: z.boolean().optional().describe('Nothing was started: the server was already in that state'),
  }),
  'ServerOperationResult',
  'The answer to create, start, stop and destroy.',
);

export const ListServersQuerySchema = z.object({
  limit: z.string().optional().describe('1–100, default 50'),
  cursor: z.string().optional().describe('From the previous page'),
  all: z.enum(['true', 'false']).optional().describe('Include destroyed servers'),
});

export const ListServersResponseSchema = named(
  z.object({
    servers: z.array(ServerRecordSchema),
    cursor: z.string().optional().describe('Present when there are more; pass it back for the next page'),
  }),
  'ListServersResponse',
);

export const MyServersQuerySchema = z.object({
  all: z.enum(['true', 'false']).optional().describe('Include destroyed servers'),
});

export const ListMyServersResponseSchema = named(
  z.object({ servers: z.array(ServerViewSchema).describe('Newest first') }),
  'ListMyServersResponse',
  'The servers the caller owns or is a member of.',
);

export const BackupSummarySchema = named(
  z.object({ key: z.string(), takenAt: isoTime('When the upload finished'), bytes: z.number().int() }),
  'BackupSummary',
);

export const InviteSchema = named(
  z.object({
    code: z.string().describe('XXXX-XXXX-XXXX-XXXX-XXXX: what a friend accepts (dashes, spaces and case don\'t matter)'),
    createdBy: z.string().describe("The creator's user ID"),
    createdAt: isoTime('Created'),
    expiresAt: isoTime('When it stops working (7 days)'),
  }),
  'Invite',
  'A code that makes whoever accepts it a member of a server: they can see it, start and stop it.',
);

export const ListInvitesResponseSchema = named(
  z.object({ invites: z.array(InviteSchema).describe('Unexpired, newest first') }),
  'ListInvitesResponse',
);

export const MemberSchema = named(
  z.object({
    userId: z.string(),
    role: z.enum(['owner', 'member']),
    name: z.string().optional().describe('Their display name, name or username, whichever their sign-in gave'),
    picture: z.string().optional().describe('Avatar URL'),
    addedAt: isoTime('When they got access'),
    addedBy: z.string().describe('Who let them in: the invite\'s creator (the owner, for themselves)'),
  }),
  'Member',
  'Someone with access to a server. No email: members see each other.',
);

export const ListMembersResponseSchema = named(
  z.object({ members: z.array(MemberSchema).describe('The owner first, then members by when they joined') }),
  'ListMembersResponse',
);

export const ServerBackupsResponseSchema = named(
  z.object({
    backups: z
      .array(
        z.object({
          id: z.string().describe('Its file name, e.g. 20261005T120000Z.tar.gz: what a restore takes as `key`'),
          takenAt: isoTime('When it finished'),
          bytes: z.number().int(),
        }),
      )
      .describe('Newest first'),
  }),
  'ServerBackupsResponse',
  "A server's backups, as owners see them (no storage keys).",
);

export const ListBackupsResponseSchema = named(z.object({ backups: z.array(BackupSummarySchema) }), 'ListBackupsResponse', 'Newest first.');

// The signed-in user.

export const MeResponseSchema = named(
  z.object({
    userId: z.string().describe("The Cognito user's sub"),
    admin: z.boolean().describe('In the admin group: may act on every server'),
    approved: z.boolean().describe('May create servers (new users wait for an admin)'),
    serverLimit: z.number().int().describe('Servers they may own at once'),
    provider: z.string().optional().describe('How they signed in: Google, Discord, or Cognito (a password)'),
    email: z.string().optional(),
    name: z.string().optional().describe('From Google'),
    username: z.string().optional().describe('From Discord'),
    displayName: z.string().optional().describe('From Discord'),
    picture: z.string().optional().describe('Avatar URL'),
    createdAt: isoTime('First seen'),
  }),
  'MeResponse',
  'Who the caller is, as Hearth knows them.',
);

export const UserRecordSchema = named(
  z.object({
    userId: z.string().describe("The Cognito user's sub"),
    approved: z.boolean().describe('May create servers'),
    serverLimit: z.number().int().describe('Servers they may own at once'),
    createdAt: isoTime('First seen'),
    lastSeenAt: isoTime('Last profile refresh'),
    approvedAt: isoTime('When approved').optional(),
    provider: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
    username: z.string().optional(),
    displayName: z.string().optional(),
    picture: z.string().optional(),
  }),
  'UserRecord',
  'A user as admins see them: the whole record.',
);

export const SetApprovalRequestSchema = named(
  z.strictObject({ approved: z.boolean().describe('true approves; false takes approval back') }),
  'SetApprovalRequest',
);

// Uploads.

export const CreateUploadRequestSchema = named(z.strictObject({ game: GameIdSchema }), 'CreateUploadRequest');

export const CreateUploadResponseSchema = named(
  z.object({
    uploadId: z.string(),
    url: z.string().describe('POST a multipart/form-data form here: every field in `fields`, then the file last as `file`'),
    fields: z.record(z.string(), z.string()),
    maxBytes: z.number().int().describe('S3 refuses larger files'),
    expiresAt: isoTime('When the form stops working'),
  }),
  'CreateUploadResponse',
  'A presigned S3 form for one upload.',
);

export const UploadStatusSchema = named(
  z.discriminatedUnion('status', [
    z.object({ uploadId: z.string(), status: z.literal('repacking') }),
    z.object({
      uploadId: z.string(),
      status: z.literal('accepted'),
      bytes: z.number().int(),
      game: z.string().optional(),
    }),
    z.object({ uploadId: z.string(), status: z.literal('rejected'), reason: z.string() }),
  ]),
  'UploadStatus',
  'How the repack check is getting on with an upload.',
);

// The agent's routes.

export const AgentTargetSchema = named(
  z.object({ version: z.string(), sha256: z.string(), url: z.string().describe('s3://bucket/key of the binary') }),
  'AgentTarget',
);

export const RestoreTargetSchema = named(
  z.object({ key: z.string(), url: z.string().describe('Presigned download link, valid 15 minutes') }),
  'RestoreTarget',
);

export const AgentConfigSchema = named(
  z.object({
    serverId: z.string(),
    game: GameIdSchema,
    version: z.string(),
    image: z.string(),
    port: z.number().int(),
    agent: AgentTargetSchema.optional().describe("The release this server's channel points at"),
    restore: RestoreTargetSchema.optional().describe('Replace the game data with this before starting the game'),
    idleStopMinutes: z.number().int().describe('0 = never'),
  }),
  'AgentConfig',
);

export const AgentStatusReportSchema = named(
  z.object({
    state: AgentStateSchema,
    agentVersion: z.string().min(1).max(64),
    message: z.string().max(500).optional().describe('Short detail, e.g. the error'),
  }),
  'AgentStatusReport',
);

export const BackupTargetSchema = named(
  z.object({
    bucket: z.string(),
    key: z.string(),
    region: z.string(),
    credentials: z.object({
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
      sessionToken: z.string(),
      expiration: isoTime('When they stop working'),
    }),
  }),
  'BackupTarget',
  'Where to upload one backup, with credentials that can write only that key.',
);

export const BackupDoneReportSchema = named(z.object({ key: z.string().min(1) }), 'BackupDoneReport');

export const RestoreDoneReportSchema = named(z.object({ key: z.string().min(1) }), 'RestoreDoneReport');

export const IdleReportSchema = named(
  z.object({ idleMinutes: z.number().int().min(1).max(MAX_IDLE_STOP_MINUTES) }),
  'IdleReport',
  'Nobody has played for this long: stop the server.',
);

export type ServerView = z.infer<typeof ServerViewSchema>;
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
export type SetVersionRequest = z.infer<typeof SetVersionRequestSchema>;
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>;
export type ServerOperationResult = z.infer<typeof ServerOperationResultSchema>;
export type ListServersResponse = z.infer<typeof ListServersResponseSchema>;
export type BackupSummary = z.infer<typeof BackupSummarySchema>;
export type ListBackupsResponse = z.infer<typeof ListBackupsResponseSchema>;
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;
export type UploadStatus = z.infer<typeof UploadStatusSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type RestoreTarget = z.infer<typeof RestoreTargetSchema>;
export type AgentStatusReport = z.infer<typeof AgentStatusReportSchema>;
export type BackupTarget = z.infer<typeof BackupTargetSchema>;
export type BackupDoneReport = z.infer<typeof BackupDoneReportSchema>;
export type RestoreDoneReport = z.infer<typeof RestoreDoneReportSchema>;
export type IdleReport = z.infer<typeof IdleReportSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type ListMyServersResponse = z.infer<typeof ListMyServersResponseSchema>;
export type ServerBackupsResponse = z.infer<typeof ServerBackupsResponseSchema>;
export type Invite = z.infer<typeof InviteSchema>;
export type ListInvitesResponse = z.infer<typeof ListInvitesResponseSchema>;
export type Member = z.infer<typeof MemberSchema>;
export type ListMembersResponse = z.infer<typeof ListMembersResponseSchema>;
export type SetApprovalRequest = z.infer<typeof SetApprovalRequestSchema>;
