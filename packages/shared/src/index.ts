export * from './access.js';
export * from './agent-api.js';
export * from './agent-releases.js';
export * from './backups.js';
export * from './environments.js';
export * from './fleet-check.js';
export * from './games.js';
export * from './metrics.js';
export * from './permissions.js';
export * from './server.js';
export * from './uploads.js';
// The API's body types, as types only: the schemas themselves (and Zod) load from
// `@hearth/shared/api`, so code that only needs the types doesn't bundle them.
export type {
  AgentConfig,
  AgentStatusReport,
  BackupDoneReport,
  BackupSummary,
  BackupTarget,
  CreateServerRequest,
  CreateUploadRequest,
  CreateUploadResponse,
  ErrorResponse,
  IdleReport,
  ListBackupsResponse,
  ListMyServersResponse,
  ListServersResponse,
  MeResponse,
  RestoreDoneReport,
  RestoreRequest,
  RestoreTarget,
  ServerBackupsResponse,
  ServerOperationResult,
  ServerView,
  SetApprovalRequest,
  SetVersionRequest,
  UpdateSettingsRequest,
  UploadStatus,
} from './api/schemas.js';
