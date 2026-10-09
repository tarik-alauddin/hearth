// The Cognito `admin` group, changed with the caller's own AWS credentials: no API route can grant
// admin, so a bug in the API can't either.
import {
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
  type UserType,
} from '@aws-sdk/client-cognito-identity-provider';

/** The Cognito group whose members are Hearth admins (AuthStack's ADMIN_GROUP). */
export const ADMIN_GROUP = 'admin';

export interface PoolUser {
  /** The Cognito username: `Google_…`, `Discord_…`, or a password user's. */
  username: string;
  /** Hearth's user ID (the `sub`). */
  userId: string;
  email?: string;
}

/** The few Cognito calls the admin commands make. */
export interface AdminGroup {
  findUser(userId: string): Promise<PoolUser | undefined>;
  add(username: string): Promise<void>;
  remove(username: string): Promise<void>;
  list(): Promise<PoolUser[]>;
}

export function cognitoAdminGroup(userPoolId: string, region: string): AdminGroup {
  const client = new CognitoIdentityProviderClient({ region });
  const toUser = (user: UserType): PoolUser => {
    const attr = (name: string) => user.Attributes?.find((a) => a.Name === name)?.Value;
    return { username: user.Username ?? '', userId: attr('sub') ?? '', ...(attr('email') ? { email: attr('email') } : {}) };
  };
  return {
    async findUser(userId) {
      if (!/^[0-9a-f-]{36}$/.test(userId)) return undefined; // also keeps quotes out of the filter
      const out = await client.send(new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${userId}"`, Limit: 1 }));
      const user = out.Users?.[0];
      return user ? toUser(user) : undefined;
    },
    async add(username) {
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: ADMIN_GROUP }));
    },
    async remove(username) {
      await client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: ADMIN_GROUP }));
    },
    async list() {
      const users: PoolUser[] = [];
      let next: string | undefined;
      do {
        const out = await client.send(new ListUsersInGroupCommand({ UserPoolId: userPoolId, GroupName: ADMIN_GROUP, NextToken: next }));
        users.push(...(out.Users ?? []).map(toUser));
        next = out.NextToken;
      } while (next);
      return users;
    },
  };
}
