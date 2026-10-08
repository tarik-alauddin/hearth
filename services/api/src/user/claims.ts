import type { UserProfile } from '@hearth/shared';
import type { Actor } from '../authz.js';

/** The checked ID token's claims, as API Gateway's JWT authorizer passes them to the Lambda. */
export type Claims = Record<string, string | number | boolean | string[] | undefined>;

/** The Cognito group whose members are Hearth admins (AuthStack's ADMIN_GROUP). */
const ADMIN_GROUP = 'admin';

/** Who is calling, from a checked ID token: the actor, and their profile to record. */
export interface Caller {
  userId: string;
  admin: boolean;
  actor: Actor;
  profile: UserProfile;
}

/**
 * Reads the caller from the token's claims. API Gateway has already checked the token's
 * signature, issuer, expiry and client; this only refuses a token that isn't an ID token (an
 * access token carries no profile) or has no subject. Undefined: refuse the request.
 */
export function callerFromClaims(claims: Claims | undefined): Caller | undefined {
  const userId = text(claims?.sub);
  if (!claims || !userId || claims.token_use !== 'id') return undefined;
  const admin = groups(claims['cognito:groups']).includes(ADMIN_GROUP);
  return {
    userId,
    admin,
    actor: admin ? { kind: 'admin', id: userId } : { kind: 'user', userId },
    profile: profileFromClaims(claims),
  };
}

/** The profile fields a token carries; which ones depends on how the user signed in. */
function profileFromClaims(claims: Claims): UserProfile {
  const fields = {
    provider: provider(text(claims['cognito:username'])),
    email: text(claims.email),
    name: text(claims.name), // Google
    username: text(claims.preferred_username), // Discord
    displayName: text(claims.nickname), // Discord
    picture: text(claims.picture),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as UserProfile;
}

/**
 * How the user signed in. Cognito names federated users `<Provider>_<their id there>`
 * (`Google_1234…`, `Discord_5678…`); a password user's username is their sub.
 */
function provider(username: string | undefined): string {
  return /^([A-Za-z]+)_/.exec(username ?? '')?.[1] ?? 'Cognito';
}

/**
 * A list claim. API Gateway passes `cognito:groups` either as an array or flattened into one
 * string, `[admin other]` or `[admin, other]`; both read the same.
 */
function groups(claim: Claims[string]): string[] {
  if (Array.isArray(claim)) return claim;
  if (typeof claim !== 'string' || !claim) return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

function text(value: Claims[string]): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
