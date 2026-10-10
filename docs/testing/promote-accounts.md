# Promoting accounts (M8) to stage and prod

M8 changes how you reach an environment: `/admin` is gone, so the CLI and every admin action go
through your Cognito sign-in, and each environment has its own user pool. Running servers and their
agents are unaffected (the deploy only adds tables, routes and the sign-in stack). Do stage first;
prod only takes a release stage has run.

**Before you start:** the release you want is on dev and tested there (the newest `v…` release on
GitHub). Servers created before M8 belong to your old AWS identity and have no owner row: as an
admin you still reach them; nobody else does.

## 1. Promote to stage

GitHub → Actions → **Promote** → Run workflow: what = `release`, env = `stage`, which = `promote`
(the newest release). Wait for it to go green. Promoting a release also puts its agent on stage's
canary channel.

## 2. Your stage user, as an admin

Follow [sign-in.md](sign-in.md) sections 0–2 with `$Env = 'stage'`: section 1 creates your password
user and adds it to the `admin` group, section 2 signs in once (and sets your password).

Then sign the CLI in and check:

```powershell
pnpm hearth login --env stage
pnpm hearth whoami --env stage     # "admin yes", "servers no limit (admin)"
```

`admin no`? The group is read when tokens are issued: `pnpm hearth logout --env stage`, then log in again.

## 3. Smoke test on stage

```powershell
pnpm hearth list --env stage                 # every server (the admin view)
pnpm hearth status <serverId> --env stage    # owner, agent, channel, instance rows
pnpm hearth start <serverId> --env stage     # … Ready. Join at <ip>:25565
pnpm hearth stop <serverId> --env stage      # Stopped. Game saved.
```

No servers on stage? `pnpm hearth create --version <your client's version> --env stage`, then
`stop` and `destroy` it when done.

## 4. Prod

Promote again with env `prod`, then sections 2 and 3 with `prod` in place of `stage`. In prod, keep
the smoke test to `list` and `status` unless a start is wanted anyway (a start runs, and bills, an
instance).

## Later: Google and Discord sign-in on stage and prod

Only password users can sign in there until the providers are on (friends need them). Per
environment:

1. Create the secrets `hearth/<env>/google` and `hearth/<env>/discord`
   ([google.md](../setup/google.md), [discord.md](../setup/discord.md)).
2. Add that environment's redirect URL, `https://hearth-<env>-138300868928.auth.us-west-2.amazoncognito.com/oauth2/idpresponse`,
   in the Google OAuth client and the Discord app.
3. Turn them on in `infra/lib/config.ts` (`SIGN_IN_PROVIDERS`) in a small PR; it deploys with the
   next promote. A provider turned on before its secret exists fails that environment's deploy.
