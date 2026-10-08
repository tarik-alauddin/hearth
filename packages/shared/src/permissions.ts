import type { ServerRole } from './access.js';

/** Something a user can do to one server. */
export type ServerAction =
  | 'view' // see it, its status and join address
  | 'start'
  | 'stop'
  | 'settings' // idle stop and other settings
  | 'version' // upgrade the game version
  | 'backups' // list its backups
  | 'restore' // request or cancel a restore
  | 'destroy'
  | 'invite' // create, list and revoke invite links
  | 'members' // see who has access
  | 'removeMember'; // take someone's access away (leaving yourself is always allowed)

/**
 * Who may do what to a server. The only place these rules are written: the API enforces them
 * (`authorize`), the UI uses them to show only what a user can do. Admins may do everything,
 * and a game's agent may only stop its own server (for idle stop); neither is a role here.
 */
export const SERVER_PERMISSIONS: Readonly<Record<ServerAction, readonly ServerRole[]>> = {
  view: ['owner', 'member'],
  start: ['owner', 'member'],
  stop: ['owner', 'member'],
  settings: ['owner'],
  version: ['owner'],
  backups: ['owner'],
  restore: ['owner'],
  destroy: ['owner'],
  invite: ['owner'],
  members: ['owner', 'member'],
  removeMember: ['owner'],
};

/** Whether `role` may do `action`. */
export function roleCan(role: ServerRole, action: ServerAction): boolean {
  return SERVER_PERMISSIONS[action].includes(role);
}
