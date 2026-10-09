import type { MeResponse } from '@hearth/shared';
import type { AdminGroup } from './admins.js';
import { readJwt, type Session, type Tokens } from './auth.js';
import type { Api } from './client.js';
import { CommandError } from './commands.js';

export interface AccountDeps {
  env: string;
  /** Signs in through the browser. */
  signIn: (provider?: string) => Promise<Tokens>;
  session: { write(session: Session): Promise<void>; remove(): Promise<boolean> };
  /** The /v1 API as the signed-in user. */
  api: () => Promise<Api>;
  /** The environment's `admin` group (Cognito, with your AWS credentials). */
  admins: () => Promise<AdminGroup>;
  print: (line: string) => void;
}

/** Signing in and out, and the admin group. */
export function accountCommands({ env, signIn, session, api, admins, print }: AccountDeps) {
  async function poolUser(group: AdminGroup, userId: string) {
    const user = await group.findUser(userId);
    if (!user) throw new CommandError(`No user ${userId} in ${env}'s user pool (the userId from hearth whoami, or /v1/me)`);
    return user;
  }

  return {
    async login(provider?: string) {
      const tokens = await signIn(provider);
      if (!tokens.refresh_token) throw new CommandError('Cognito returned no refresh token; not saving the session');
      await session.write({ idToken: tokens.id_token, refreshToken: tokens.refresh_token });
      const claims = readJwt(tokens.id_token);
      const who = [claims.name, claims.nickname, claims.preferred_username, claims.email].find((v) => typeof v === 'string');
      print(`Signed in to ${env}${who ? ` as ${String(who)}` : ''}. The session lasts 30 days; hearth logout ends it here.`);
    },

    async logout() {
      print((await session.remove()) ? `Signed out of ${env} on this machine.` : `Not signed in to ${env}.`);
    },

    async whoami() {
      const me = await (await api()).get<MeResponse>('/v1/me');
      const name = me.displayName ?? me.name ?? me.username;
      print(`${name ?? me.email ?? me.userId}${name && me.email ? ` <${me.email}>` : ''}`);
      print(`  user ID   ${me.userId}`);
      print(`  sign-in   ${me.provider ?? 'unknown'}`);
      print(`  admin     ${me.admin ? 'yes' : 'no'}`);
      print(`  approved  ${me.approved ? 'yes' : 'no (an admin approves you before you can create servers)'}`);
      print(`  servers   ${me.admin ? 'no limit (admin)' : `up to ${me.serverLimit}`}`);
    },

    async adminAdd(userId: string) {
      const group = await admins();
      const user = await poolUser(group, userId);
      await group.add(user.username);
      print(`${user.email ?? user.username} is now an admin of ${env}, from their next sign-in or token refresh (within an hour).`);
    },

    async adminRemove(userId: string) {
      const group = await admins();
      const user = await poolUser(group, userId);
      await group.remove(user.username);
      // Tokens carry the groups as of when they were issued; each refresh (hourly) reads them again.
      print(`${user.email ?? user.username} is no longer an admin of ${env}, from their next token refresh (within an hour).`);
    },

    async adminList() {
      const users = await (await admins()).list();
      if (!users.length) return print(`No admins in ${env}.`);
      for (const user of users) print(`${user.userId}  ${user.email ?? user.username}`);
    },
  };
}
