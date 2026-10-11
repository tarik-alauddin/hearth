# Promoting accounts (M8) and the web app to stage and prod

M8 changes how you reach an environment: `/admin` is gone, so the CLI and every admin action go
through your Cognito sign-in, and each environment has its own user pool. Running servers and their
agents are unaffected (the deploy only adds tables, routes and the sign-in stack). Do stage first;
prod only takes a release stage has run.

**Before you start:**

- The release you want is on dev and tested there (the newest `v…` release on GitHub).
- Google and Discord are on in every environment, so the environment's secrets must exist, or its
  deploy fails: `hearth/<env>/google` and `hearth/<env>/discord`, from its own Google OAuth client
  and Discord app ([google.md](../setup/google.md), [discord.md](../setup/discord.md)). Check:
  `aws secretsmanager list-secrets --region us-west-2 --query "SecretList[].Name"`.
- Google's project is in **Testing** until published (Audience): only listed test users can sign in,
  in every environment. Publish it, or list your friends, before they use prod.

 Servers created before M8 belong to your old AWS identity and have no owner row: as an
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

## 4. The web app and outside sign-in on stage

```powershell
aws ssm get-parameter --region us-west-2 --name /hearth/stage/web-url --query Parameter.Value --output text
```

Open it, **Sign in** with your password user: "Welcome, …", no "Waiting for approval" (admins need
none). **Sign out**, then sign in with Google and with Discord: each is a new user, "Waiting for
approval" until `pnpm hearth approve <userId> --env stage` (the ID: the newest item in the
`hearth-stage-Users` table, DynamoDB console). To make your Google user an admin instead:
`pnpm hearth admin add <userId> --env stage`, then sign out and in again. Details: [sign-in.md](sign-in.md) §7.

## 5. Prod

Promote again with env `prod`, then sections 2–4 with `prod` in place of `stage`. In prod, keep
the smoke test to `list` and `status` unless a start is wanted anyway (a start runs, and bills, an
instance).

