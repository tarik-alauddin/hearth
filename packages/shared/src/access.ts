// Accounts and access (M8): who a user is, which servers they can reach, and invite links.
// Admins aren't recorded here: admin is the Cognito `admin` group, read from the caller's token.

/** Servers a user may own (not counting destroyed ones) unless their record says otherwise. */
export const DEFAULT_SERVER_LIMIT = 3;

/** How long an invite link works. */
export const INVITE_TTL_DAYS = 7;

/** GSI on `Servers`: `ownerId` + `createdAt`, projecting `status`, for counting a user's servers. */
export const SERVERS_BY_OWNER_INDEX = 'byOwner';

/** GSI on `ServerAccess`: `serverId` + `userId`, for a server's owner and members. */
export const ACCESS_BY_SERVER_INDEX = 'byServer';

/** GSI on `Invites`: `serverId` + `createdAt`, for a server's invite links. */
export const INVITES_BY_SERVER_INDEX = 'byServer';

/** An item in the `Users` table, keyed by the Cognito user's `sub`. */
export interface UserRecord {
  userId: string;
  /** May create servers. New users wait for an admin to approve them. */
  approved: boolean;
  /** Servers they may own at once (default DEFAULT_SERVER_LIMIT). */
  serverLimit: number;
  createdAt: string; // ISO 8601 UTC: first seen
  lastSeenAt: string; // ISO 8601 UTC: last profile refresh
  approvedAt?: string; // ISO 8601 UTC
  // Profile, refreshed from the sign-in token; which fields arrive depends on the provider.
  provider?: string; // 'Google', 'Discord', or 'Cognito' (a password user)
  email?: string;
  name?: string; // Google
  username?: string; // Discord
  displayName?: string; // Discord
  picture?: string; // avatar URL
}

/** The profile fields of a user, as read from their token. */
export type UserProfile = Pick<UserRecord, 'provider' | 'email' | 'name' | 'username' | 'displayName' | 'picture'>;

/** What a user is to a server. Admins reach every server without an access item. */
export type ServerRole = 'owner' | 'member';

/** An item in the `ServerAccess` table: one user's access to one server. */
export interface ServerAccessRecord {
  userId: string;
  serverId: string;
  role: ServerRole;
  addedAt: string; // ISO 8601 UTC
  /** Who granted it: for a member, the invite's creator; for the owner, themselves (at create). */
  addedBy: string;
  /** The invite it came through, for members. */
  inviteCode?: string;
}

/** An item in the `Invites` table: a link that makes whoever accepts it a member of a server. */
export interface InviteRecord {
  /** 20 Crockford base32 characters (100 random bits), stored without dashes. */
  code: string;
  serverId: string;
  createdBy: string;
  createdAt: string; // ISO 8601 UTC
  expiresAt: string; // ISO 8601 UTC; checked on every read
  /** The same moment in epoch seconds: DynamoDB's TTL deletes the item some time after it. */
  expiresAtEpoch: number;
}
