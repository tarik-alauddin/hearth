# Hearth: notes for Claude

Hearth is a game server hosting platform on AWS (CDK in TypeScript, a Go agent on each game instance),
built for a small gaming group first. This file is read at the start of every session; keep it current
as part of each PR. The repo layout and commands are in [README.md](README.md).

## Where things are

- **Architecture doc:** Claude Doc "Hearth — Architecture", https://claude.ai/artifact/9a4UdwjXfggsVDFotYdqxJ
  - **Architecture** tab: the reference; its Roadmap table tracks milestones.
  - **System map** tab: diagram and components as built; update it as milestones land.
  - **Outdated: original architecture** tab: history only, never edit.
- **Testing guides:** `docs/testing/`. The owner runs AWS checks from CloudShell or their own terminal.
  Write new guides' commands for **PowerShell** (the owner's shell; Windows PowerShell 5.1 too):
  no `jq` (use `ConvertFrom-Json` / `Invoke-RestMethod`), quote arguments with commas, pass JSON to
  `aws` through a file (5.1 strips its quotes). Multi-step checks get a script (e.g.
  `scripts/sign-in-check.ps1`) rather than copy-paste.

## Working agreement

- The owner creates branches, commits and merges; one reviewable PR at a time. Ask before starting a
  new milestone.
- Keep PRs small: one layer or concern each (e.g. API route, then infra, then agent). Split a
  milestone PR into several before starting, and agree the split with the owner.
- Be concise, in replies and especially in doc updates: tables and short bullets, folded into existing
  sections.
- Use `pnpm`. pnpm is pinned in `package.json`, and build scripts must be approved in `pnpm-workspace.yaml`
  (`allowBuilds`). After changing dependencies, check `pnpm install --frozen-lockfile` passes, as CI uses it.
- Before handing over a change, run `pnpm lint`, `pnpm typecheck` and `pnpm test`. Use `pnpm synth` for
  infra changes, and shellcheck (`koalaman/shellcheck:latest` in Docker) for shell scripts.
- CI runs on Linux; this machine is Windows (paths, `path.basename`, line endings differ). Also run
  the tests on Linux before handing over: in a `node:24` container, copy the repo without
  `node_modules`, `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm test`. A test passing
  only on Windows failed PR4's CI.
- Windows + Git Bash: set `MSYS_NO_PATHCONV=1` for AWS CLI calls with `/hearth/...` paths. `.sh` and `.go`
  files must stay LF (`.gitattributes`). Prefer the Edit tool over shell or Python rewrites of source files.
- Local `pnpm synth` on this machine: CDK calls `pnpm.cmd`, but Volta installs `pnpm.exe`; put a
  `pnpm.cmd` shim (`@pnpm.exe %*`) on PATH for the run. Go isn't installed: run agent checks in the
  `golang:1.27` Docker image.
- Lambdas bundle as ESM: a function bundling CommonJS packages (e.g. yauzl) needs
  `commonJsDependencies: true` in `hearthFunction`, or it fails at runtime with "Dynamic require"
  (unit tests and `node -e` don't show it). Load the synthesized bundle as ESM to check.
- API routes and bodies live in `packages/shared/src/api` only: add or change a route in
  `routes.ts` (a body in `schemas.ts`), handle it, then `pnpm api:spec` and commit
  `docs/api/openapi.json`. Import Zod as `import * as z from 'zod'` (the named `{ z }` import
  bundles all of Zod: 800 KB Lambdas). Code that only needs types imports them from `@hearth/shared`.
- In Git Bash, `node` is a `winpty` alias that swallows output and can't take piped input: use
  `node.exe`, or run a script file.
- S3 answers a missing key with 403, not 404, unless the caller (or a link's signer) has
  `s3:ListBucket` on the bucket.

## Status (update with each PR)

| Milestone | Status |
| --- | --- |
| M0–M4: foundation, infra, agent, lifecycle workflows, agent releases; plus monitoring | Done |
| M5 Game updates and backups | Done (PR1–PR9; follow-ups under Deferred) |
| M6 Idle shutdown | Done (PR1–PR4; join events from the log under Deferred) |
| M7 Move your world | Done (PR1–PR4; tested on dev with a real world) |
| Before Phase 2 | Done: M7 docs, neutral wording, destroy (records kept as `DESTROYED`), state-sync tweak, stage and prod live with the release flow (details under Decisions) |
| **Phase 1** | **Complete** (2026-10-07): dev, stage and prod run `v2026.10.07-3461efe`, agent `2026.10.06-de42566` |
| M8 Accounts and access | In progress: PR1a–PR1c done (sign-in with password, Google, Discord, tested on dev); PR2–PR4 done (access data, authorization, API contract); PR5 merged (every server action on `/v1`); PR6a (invites) and PR6b (members) in review |
| M9 Game version catalog | Planned (Deferred's plan, V1–V4) |
| M10 Web UI | Planned |

**Phase 2** (the UI phase): M8 → M9 → M10. Design under Decisions ("Accounts and access").

**M8 plan** (done when a signed-in user manages their own and friends' servers through `/v1`, and
the CLI signs in the same way; backend only):
- PR1a Auth basics, done (tested on dev: password sign-in, tokens with `cognito:groups`,
  refresh): AuthStack per env, Cognito user pool (Essentials), managed login v2 on
  `hearth-<env>-<account>`, a CLI client (`localhost:8976/callback`) and a web client where
  `webOrigins` lists one (dev: Vite), both public (PKCE), refresh-only auth flows; an `admin`
  group; `/hearth/<env>/auth` (JSON: pool, issuer, domain, client IDs). Password users created by
  the owner only (no self sign-up), MFA optional (TOTP). Guide: `docs/testing/sign-in.md`.
- PR1b Google, done (tested on dev; the owner's Google user is an admin):
  `UserPoolIdentityProviderGoogle` from `hearth/<env>/google` (`{clientId, clientSecret}`, resolved
  by CloudFormation), email, verified, name and picture mapped; clients depend on the provider. Per
  env `signInProviders` (dev now; stage and prod once their secrets exist, or their deploy fails).
  Setup guide `docs/setup/google.md`. Federated users are `<Provider>_<id>` (`Google_…`), separate
  from a password user with the same email (no linking; add to `admin` by hand).
- PR1c Discord, done (tested on dev): Cognito's generic OIDC provider (`Discord`), no wrapper: Discord
  publishes OIDC discovery (issuer `https://discord.com`, ID tokens with `openid`, userinfo, JWKS,
  PKCE); endpoints spelled out from it. Scopes `openid identify email`; email, verified,
  `preferred_username` (username), `nickname` (display name), `picture` mapped. Secret
  `hearth/<env>/discord`; setup guide `docs/setup/discord.md`. Rides along: the sign-in guide in
  PowerShell around `scripts/sign-in-check.ps1` (browser sign-in, loopback callback, PKCE, claims,
  refresh; `-Provider`, `-Client web`, `-SignOut`), and the PowerShell secret steps for Google.
  Public email sign-up: not planned (resets, SES, spam).
- PR2 Access data, done (deployed to dev; nothing writes them yet: PR5 does). DataStack tables,
  all with point-in-time recovery, retained and deletion-protected in prod:
  - `hearth-<env>-Users` (`userId` = Cognito `sub`): `approved`, `serverLimit` (default 3),
    `createdAt`/`lastSeenAt`/`approvedAt`, profile from the token (provider, email, name, username,
    displayName, picture). No admin flag: admin is the Cognito group, one source of truth.
  - `hearth-<env>-ServerAccess` (`userId` + `serverId` → role owner | member, addedAt, addedBy,
    inviteCode); index `byServer` (`serverId` + `userId`).
  - `hearth-<env>-Invites` (`code`: 20 Crockford base32 chars, 100 bits, stored undashed, shown
    `XXXX-…`): serverId, createdBy, createdAt, expiresAt (7 days), TTL on `expiresAtEpoch`; index
    `byServer` (`serverId` + `createdAt`). Codes stored plain (hashing only helps if this table leaks alone).
  - Servers: index `byOwner` (`ownerId` + `createdAt`, projecting `status`) for the cap count.
  - `services/core`: `UsersStore` (`recordSignIn` creates unapproved with the default limit, never
    overwrites approval or limit; `setApproved`), `AccessStore` (`grant` only without existing
    access; `removeMember` never removes an owner; list by user or server), `InvitesStore`
    (`getActive` and lists treat expired as gone; `revoke` only for its server), `newInvite`,
    `newInviteCode` / `formatInviteCode` / `parseInviteCode` (forgiving: dashes, case, O→0, I/L→1),
    `ServersStore.countActiveOwned`. Types in `packages/shared/src/access.ts`. Left for PR5: the
    server and its owner access written in one transaction at create; what destroy does to access.
- PR3 Authorization, done (callers see no change: every existing test passes as it was):
  - **The rules:** `SERVER_PERMISSIONS` in `packages/shared/src/permissions.ts` (action → roles;
    `roleCan`), the one place they're written; the UI will read it to show only allowed actions.
  - **`services/api/src/authz.ts`:** `Actor` (`admin` with an id, `user` with a userId, `agent`
    with its server and instance); `decide()` (pure: admin anything, agent only `stop` of its own
    server, user per their role, no access → not found); `serverAuthorizer(access?)` reads the
    user's `ServerAccess` row (only for users) and throws `AccessDenied` 404 (worded like a
    missing server) or 403 ("As a member, you can't destroy server s1"); `requireAdmin` for
    platform actions; `shapeServer` (admins: the record; others: `ServerView` in shared).
  - **Operations** take the actor first and authorize before reading. Admin only: listing every
    server, creating (until PR5 adds approval, the cap and the owner's access), changing a server's
    agent channel. `idleStop` takes the agent actor. `/admin` builds an admin actor from the IAM
    caller; `/agent/idle` an agent actor. The access store is optional in the operations' deps:
    only `/v1` (PR5) has user callers, so `/admin` and agent Lambdas get no new permission.
  - Tests: the full role × action matrix spelled out (changing a rule must change the test),
    404/403 wording, no access reads for admins and agents, shaping, and operations refusing a
    member the owner's actions before changing anything.
- PR4 API contract, done. A refactor: the deployed routes, integrations and IAM are
  identical (checked against the previous synth); only Lambda code changes.
  - `packages/shared/src/api` (imported as `@hearth/shared/api`): `schemas.ts` (Zod 4.6: every
    request and response body, named in a registry; the types keep their names, re-exported
    type-only from `@hearth/shared`, so Lambdas that don't check requests don't bundle Zod),
    `routes.ts` (`API_ROUTES`: id, method, path, caller, handler Lambda, bodies, responses),
    `openapi.ts` (OpenAPI 3.1 from Zod's JSON Schema; no extra library). `admin-api.ts` is gone;
    `ServerView`, `UploadStatus` and the agent bodies moved into the schemas. `ServerRecord` stays
    core's interface; its schema documents it and a type test keeps the two equal.
  - The API's checks go through the schemas (`services/api/src/validation.ts`): the four
    `validate*` functions and the agent handlers' parsers are gone. Behaviour kept (limits, the
    agent's caller-then-body order), except: create now refuses unknown fields like the others.
  - The CDK builds every route from `API_ROUTES` (unknown handler or a user route fails synth);
    tests: deployed routes equal the list both ways, each reaches its named Lambda.
  - `docs/api/openapi.json` (committed; `pnpm api:spec`; `infra/test/api-spec.test.ts` fails when
    stale; valid per Redocly). `pnpm api:docs`: Swagger UI from `swagger-ui-dist` on 127.0.0.1:8090,
    "try it out" off (SigV4). `@scarf/scarf` (its analytics install script) is denied in `allowBuilds`.
  - **Import Zod as `import * as z from 'zod'`**, never `import { z }`: only the namespace import
    lets esbuild drop unused parts. With `import { z }` the Admin and agent bundles were 800 KB;
    now about 250 KB (the code was 41–45 KB; Zod adds about 130 KB unminified, ~80 KB minified).
    `zod/mini` would be 13 KB but means rewriting the schemas in its functional style.
  - Hosted docs come with M10: on in dev and stage, off in prod (see Decisions).
- PR5 `/v1`, split in five (PR4 was too big; keep each to one concern):
  - 5a, merged: `GET /v1/me`. API Gateway's JWT authorizer (`HttpUserPoolAuthorizer`
    `hearth-<env>-cognito`: AuthStack's pool and clients, passed in; AuthStack is now built before
    ApiStack) on `/v1` routes, IAM on the rest. Clients send the **ID token** (it carries the
    profile and groups; access tokens are refused with 401). The `User` λ
    (`services/api/src/user`): `callerFromClaims` (admin = `admin` group; provider from the
    `<Provider>_` username prefix; `cognito:groups` arrives as an array or a flattened `[a b]`
    string) and `/v1/me` (`recordSignIn`: first sight creates the user unapproved). It may only
    GetItem/UpdateItem the Users table. `scripts/api-call.ps1` calls any `/v1` route with a saved
    session (`~/.hearth/script-session-<env>.json`, refreshed as needed); the sign-in steps moved to
    `scripts/lib/hearth-auth.ps1`, shared with `sign-in-check.ps1`. Guide: `docs/testing/user-api.md`.
  - 5b, merged: `POST /v1/admin/users/{id}/approval` `{ approved }` (true approves, false takes
    it back; servers they own keep running), **by user ID** (one person with several sign-ins is
    several users, each approved; the M10 admin page lists pending users with names). Admins only:
    routes gain `adminOnly` (`caller: { kind: 'user', adminOnly: true }`: docs mark it and list
    403; `requireAdmin` enforces). `services/api/src/users/operations.ts` (`userOperations`,
    beside `servers/`); answers the `UserRecord` (schema checked equal to core's type); 404 for
    someone who never signed in. Logs who approved whom. No infra change.
  - 5c, merged: `GET /v1/servers` (`?all=true` adds destroyed) and `GET /v1/servers/{id}`.
    `listMyServers` reads the caller's ServerAccess rows (one Query) and each server (GetItem):
    nothing reaches a server without a row; newest first; rows whose server is gone are skipped.
    **`/v1` answers `ServerView` to everyone, admins too** (`toServerView`; `role` gains `admin`,
    for an admin on someone else's server); whole records stay on `/admin`. The User λ reads
    Servers (GetItem) and ServerAccess (GetItem, Query); its other operation dependencies throw
    "not available yet" until 5d–e wire them. No extra throttling: HTTP APIs can't throttle per
    route or user natively, and the stage's 50/s (burst 100) covers every route; per-user limits
    later if needed (e.g. WAF).
  - 5d, merged (tested on dev; the tester's admin user skipped the limit, as built): `POST /v1/servers`. `createServer` opens to users: approved (`Users`; never
    signed in = not approved) and under `serverLimit` (`countActiveOwned`, destroyed don't count;
    the simultaneous-create race accepted), else 403 with the reason; `agentChannel` needs admin;
    admins skip approval and the limit; agents refused. With the `ownership` dependency (only the
    User λ has it), the server and its owner's ServerAccess row are written in one transaction
    (`createOwnedServer` in `services/core/src/ownership.ts`, which refuses a row that isn't the
    owner's); `/admin` still writes the server alone (no owner row). Uploads on `/v1`: a 400 until
    `/v1` uploads. The User λ gains: Servers PutItem/UpdateItem, the byOwner index (Query),
    ServerAccess PutItem, StartExecution on the create workflow only; `CREATE_WORKFLOW_ARN`,
    `GAME_REGIONS`.
  - 5e, merged: `POST /v1/servers/{id}/start`, `/stop` (owners and members), `/destroy`
    (owners): thin routes over the existing operations (`authorize` with `start`/`stop`/
    `destroy`); 202 when a workflow started, 200 unchanged. The User λ may start all four
    lifecycle workflows (the operations decide who may run which).
  - 5f, merged: the owners' other actions over the existing operations: `PATCH
    /v1/servers/{id}` (settings; `agentChannel` admins only), `POST …/version`, `GET …/backups`,
    `POST` / `DELETE …/restore`. Answers are the caller's `ServerView` (role read with
    `relationTo`, one access lookup: the operations themselves are unchanged, `/admin` too).
    Backups are listed as `{ id, takenAt, bytes }`: `id` is the file name, never the storage key,
    and restore takes it (the operation already accepts a file name and checks it's one of this
    server's backups). The User λ lists backups (the same prefix-limited `ListBucket` as Admin; no
    read or write) and fetches Mojang's version list (no IAM).
  - Open (owner to decide): admins skip the limit today (and approval). Recommended: the limit
    applies to admins too (they can raise their own `serverLimit`); approval stays skipped.
  - Admin agent channels and `/v1` uploads follow as their own small PRs.
- PR6 Invites and members, split in two:
  - 6a, in review: `POST`/`GET /v1/servers/{id}/invites`, `DELETE …/invites/{code}` (owners;
    `invite` permission) and `POST /v1/invites/{code}/accept` (any signed-in user, no approval).
    `services/api/src/invites/operations.ts`. Codes are answered as `XXXX-XXXX-XXXX-XXXX-XXXX`
    (no links until the web app: M10 makes `/join/{code}`), accepted in any case with spaces
    (`parseInviteCode`). Accepting grants `member` (addedBy the invite's creator, inviteCode kept)
    unless the caller has access already (their role stays: an owner never becomes a member);
    a wrong, expired or revoked code, or a destroyed server's, is 404 alike. No invites to a
    destroyed server (409). Revoking stops new members only. The User λ reads, writes and
    deletes Invites and queries its byServer index.
  - 6b, in review: `GET /v1/servers/{id}/members` (owners and members: the owner first, then by
    join time; name and picture from Users, never emails), `DELETE …/members/{user}` (owners;
    the owner's row 409, not a member 404), `POST …/leave` (members; the owner 409, an admin
    with no row 404). `services/api/src/members/operations.ts`. The User λ may DeleteItem
    ServerAccess rows (the store deletes members only) and query its byServer index.
- PR7 CLI on Cognito: `hearth login` (browser sign-in, session in `~/.hearth`), every command on `/v1`.
- PR8 Remove `/admin` routes, their handler and permissions.

**M9** is the game version catalog plan under Deferred, its routes under `/v1`. **M10 Web UI**
(`apps/web`: React + Vite + TypeScript, static, on S3 + CloudFront): PR1 Frontend stack, skeleton,
sign-in; PR2 servers list and detail (polling, join address, start/stop); PR3 create, settings,
upgrade, destroy; PR4 upload (CORS on the uploads bucket); PR5 backups and restore; PR6 invites,
`/join/{code}`, members; PR7 admin page (approve users). No domain yet: Cognito's prefix domain
and CloudFront's default domain until there is one; callback URLs and origins come from config.

**M7 plan** (create a server from a user's upload in one step; the UI will do the same):
- PR1, merged: uploads bucket (DataStack) and `POST /admin/uploads { game }`, returning a
  presigned POST form (not a PUT link: its signed policy makes S3 enforce the 4 GiB cap, and a
  browser can submit it) for `landing/<game>/<uploadId>`, valid 15 min. The admin role can write
  `landing/*` only.
- PR2, merged (tested on dev with a real world zip): the repack Lambda (`services/repack`, ApiStack; EventBridge rule on the bucket's
  Object Created events under `landing/`; 10 GiB /tmp, 15 min, 2 GB). Reads zip (yauzl, sizes
  checked) or .tar.gz (tar-stream) by magic bytes; refuses links, unsafe paths, >200k entries,
  >8 GiB unpacked. Per-game `UploadRules` in `src/games/` (Minecraft: the folder with level.dat,
  an allowlist, to `world/`, owner 1000:1000, folders included so the game can write in them).
  Writes `accepted/<id>.tar.gz` or `rejected/<id>.json`; any internal failure is a rejection too.
  `GET /admin/uploads/{id}` reads status from the bucket (no table): repacking, accepted, rejected.
- PR3, merged, then replaced: it copied the accepted file into the backups bucket inside the create
  request. A 949 MiB upload took longer than the admin Lambda's 10 s (and API Gateway caps a request
  at 30 s), so create returned 500 and left orphan copies. Long work never runs in an API request.
- PR3b (restore-from-upload), merged (tested on dev: a real world, restored on first start): `POST /admin/servers { …, upload }` (accepted uploads
  only, for the same game: repack tags accepted files with `game` metadata) creates the server
  with a pending restore of `accepted/<id>.tar.gz` and `restoreSource: 'upload'`; no copy. The
  config Lambda signs the agent's link against the uploads bucket (read `accepted/*`, list the
  bucket); the agent and restore path are M5's, unchanged. The data becomes a backup at the first
  stop; a server not started before the upload expires (7 days) fails its first start, visibly.
  Requesting or cancelling a restore clears `restoreSource`. CLI: `hearth create --from-upload <id>`.
- PR4, merged (tested on dev; its first CI run failed on a test that only passed on Windows): `hearth create --version … --upload <file.zip|.tar.gz>`: checks the size, gets a
  form, POSTs the file to S3 (streamed from disk: `openAsBlob`; fields first, file last), polls
  `GET /admin/uploads/{id}` until accepted (or fails with repack's reason), then creates from it.
  The same steps the UI will take. `--from-upload <id>` stays for an upload already accepted.

**M6 plan** (stop servers nobody is playing on; detection runs on the instance, no heartbeats):
- PR1, merged: adapters gain `Players()` (Minecraft: the server list ping); the agent checks
  every 15 seconds while the game is ready and logs changes.
- PR2, merged: `POST /agent/idle` lets an agent stop its own `RUNNING` server through the normal
  stop workflow (so it still backs up), recording `stopReason`; `hearth status` shows it. Its
  Lambda may start only the stop workflow.
- PR3, merged: the agent's idle timer. Idle = the latest check worked and saw nobody, and no
  check has seen anyone for `IdleAfter` (30 min; `-idle-after` / `HEARTH_IDLE_AFTER` override).
  A failed check neither counts nor resets. Asks once; after a refused request, waits 5 min.
- PR4, done (tested on dev): per-server `idleStopMinutes` (default 30, 0 = never) through the settings route;
  the agent config always carries it, and it wins over the agent's `-idle-after` fallback.
  `hearth set-idle <id> <minutes|off>`; `hearth status` shows it. Applies from the next start.

**M5 plan:**
- PR1, done: the stop workflow stops the agent through SSM Run Command before stopping the instance.
- PR2, done: on that stop, the agent backs the world up to S3 and the API records it (tested on dev:
  about 10s for a small world).
- PR3, done: keep the newest 10 backups per server (tested on dev).
- PR4, done: `hearth backups <id>` lists a server's backups (`GET /admin/servers/{id}/backups`).
- PR6, done: `hearth restore <id> [<key>] [--force]` and `--cancel` record or clear
  `restoreKey` on a stopped server. Also moves the backup storage code to
  `services/api/src/backups.ts`, shared by agent and admin routes.
- PR7 (R3a, API), done: agent config carries `restore: { key, url }` (presigned when the config is
  fetched, 15 min) while a restore is pending; `POST /agent/restored` clears it; restore/cancel
  accept a stopped `FAILED` server.
- PR8 (R3b, agent), done (tested on dev): before starting the game, the agent downloads and unpacks
  the backup beside the world (refusing paths and symlinks outside it), swaps it in, then clears the
  request. Any failure fails the start with the world untouched.
- PR9, done (tested on dev, 26.2 → 26.3): `hearth set-version <id> <version>` (`POST /admin/servers/{id}/version`): stopped
  servers only; the version must be a full release in the game's version list (Mojang's manifest,
  cached 10 min, ordered by release date) and newer than the current one; needs a clean last stop
  with a backup since the server last ran. Applies on the next start.

## Decisions and why

- **One AWS account, envs dev/stage/prod** (only dev deployed): separate accounts are too much overhead
  for this scale. EC2 state-change events carry no tags, so every env's rule gets every instance's
  events; each env's state sync ignores instances that aren't its own (one lookup, plus one
  `DescribeInstances` for an unknown `running` one). That's correct, and costs fractions of a cent.
- **State sync stays as the safety net** for instance changes made outside Hearth (console stops,
  maintenance, hard stops). The workflows record what they do themselves: `RUNNING` comes with the
  public IP, so callers never see a running server without an address.
- **Deploys use the owner's existing `github-deploy` role** (OIDC, ID-based subject
  `repo:tarik-alauddin@92332908/hearth@1391534026:*`): no per-environment roles. Known gap, accepted
  while the owner is the only one with write access: it has AdministratorAccess and trusts any ref,
  so "only a release deploys prod" is the workflows' rule, not IAM's. Closing it: a prod role
  trusting only `…:environment:prod`.
- **Trunk-based; every merge is a release** (no develop or release branches: dev and stage are
  those). A merge to `main` deploys dev, then publishes pre-release `v<date>-<sha7>` carrying
  that cloud assembly and its agent (`release.json`). *Promote* "release" deploys a release's
  assembly to an env (built once, never rebuilt) and puts its agent on the env's canary; prod only
  takes one in `/hearth/stage/release`'s history, and marks it Latest. Fixes go through `main`.
- **Three workflows:** PR checks, Deploy, Promote. Shared steps are composite actions
  (`.github/actions/`), which don't clutter the Actions list the way reusable workflows do. Deploy
  runs one at a time (workflow concurrency), so a release's agent is the newest build at its commit.
  Promote runs main's workflow and actions, never a release's own copy (a rollback to a release
  older than the deploy action failed that way); only the release's assembly and agent are used.
- **All writes to the Servers, Users, ServerAccess and Invites tables go through `services/core`**;
  the API is the only entry point for callers.
- **Instances have no S3 write access.** They read agent releases only; backups use short-lived,
  per-server credentials from the API.
- **Launches use the launch template's `$Latest`.** A pinned version number went stale: a user-data-only
  change doesn't redeploy the stack that consumes it.
- **A failed workflow never leaves an instance running.** Create/start failure paths stop the instance;
  instances are tagged with `serverId` at launch.
- **Accounts and access (Phase 2):**
  - **Sign-in:** Cognito per env, Google and Discord (the owner owns those apps). Invite-only:
    anyone can sign in, only approved users create servers. Admin = the Cognito `admin` group.
    The CLI signs in through Cognito too.
  - **One API:** every action has one `/v1` route and one operation; the route never decides who
    may act. Operations take an actor and call `authorize(actor, action, server)`. The rules live
    in one place, `SERVER_PERMISSIONS` (`packages/shared/src/permissions.ts`); in short:

    | Action | Owner | Member | Admin | Agent (own server) |
    | --- | --- | --- | --- | --- |
    | See it, its address; start, stop; see its members | ✓ | ✓ | ✓ | stop (idle) |
    | Settings, version, backups, restore, destroy, invites, remove members | ✓ | — | ✓ | — |
    | Create (approved, under the cap) | user | | ✓ | — |
    | Agent channels, fleet check, approve users, every server | — | — | ✓ | — |

    No access → 404 (IDs don't leak); visible but forbidden → 403. Responses are shaped by role
    (users never see instance IDs, S3 keys, agent internals). `/agent/*` stays separate (IAM, the
    instance's own server); where it overlaps (idle stop) it calls the same operation.
  - **Cap: 3 servers per user** (`serverLimit`, so it can vary later), counted at create: owned
    servers not `DESTROYED`, one query on the owner index. Two simultaneous creates could both pass;
    accepted while the cap isn't billing.
  - **Friends join by invite link:** the owner creates a code (~100 bits, reusable, 7 days,
    revocable); a signed-in user accepts it and becomes a member. Membership is the access, not
    the code: the owner removes members, a member can leave. Accepting needs no approval (members
    create nothing). Expired, revoked, or the server destroyed → 404; TTL lags, so accept checks
    `expiresAt` itself.
  - **API docs: generated, not hosted in prod.** The OpenAPI file comes from the same schemas
    that validate requests. Publishing it isn't a hole (the web app's code reveals its routes;
    tokens, `authorize` and validation are the protection), but prod doesn't serve it or Swagger
    UI: no map of admin routes, and no third-party page on the app's origin that could read tokens.
- **Destroy:** never a running server (refused: stop it first, which also saves and backs it up). It
  removes the instance and data volume, and **keeps the server's backups and its record**, marked
  `DESTROYED` with `destroyedAt`: for history ("how many servers has Hearth run?") and so
  `hearth backups <id>` still finds its backups. Nothing else works on a destroyed server; `hearth
  list` hides it (`--all` shows it). No IAM role can delete Servers records. Backups are current
  objects, so no lifecycle rule expires them; deleting them is by hand. Confirm by typing the
  server ID; `--yes` skips the prompt. The destroy workflow's `DestroyTasks` λ is the only function
  that can terminate instances or delete volumes, and only ones tagged `app=hearth`, `env=<env>`.
- **Agents ride releases:** a merge changing `agent/` (compared with the newest build's commit,
  so a skipped run can't lose a change) builds `YYYY.MM.DD-<sha7>` onto dev canary; each release
  names its agent, and promoting it sets that env's canary. Stable moves per env by hand
  (canary → stable), and can roll back alone to any agent the env has run. Promote's "which"
  (promote / roll back / specific version) saves copying versions: dispatch inputs can't list
  releases, and running from a tag would run that tag's old workflow. Bundling's one gap: an agent
  fix can't reach an env without the platform changes merged before it (add "agent only" if needed). Pruning is count-based
  (each channel's last 3, the newest 5); a release whose agent was pruned can't be promoted.
- **Backup during the stop workflow, before the instance stops**, via Run Command
  `hearth-<env>-stop-agent`. The command finishing means the agent is done; the agent's `stopped` report
  says how it went. The agent gets 5 minutes; after about 6 the workflow stops the instance anyway and
  cancels the command. Only this path backs up: the command creates `/run/hearth/backup-on-stop`
  before stopping the agent. An OS shutdown (no marker) saves the world but skips the backup, as EC2
  may not wait long enough.
- **Backups:** `servers/<serverId>/<yyyymmdd>T<hhmmss>Z.tar.gz`, streamed (gzip, multipart upload,
  nothing staged on disk) after the game container stops. `POST /agent/backup-credentials` returns
  15-minute credentials from the `BackupWriter` role, narrowed to that one key; `POST /agent/backups`
  checks the object exists and records `lastBackup*`. Only a game that became ready is backed up.
- **A failed backup doesn't fail the stop:** the world is saved, so the agent reports `stopped` with
  the failure as its message, and `lastStopClean` stays true.
- **Stop timeouts are nested**, each a backstop for the one inside it: game container 60s, agent
  stop 270s (15s of it kept back for the final report), systemd `TimeoutStopSec` 300s, SSM command
  330s, workflow about 360s.
- **Backup retention: the newest 10 per server** (count-based), pruned by `POST /agent/backups` right
  after it records a new one; a failed prune is logged and retried by the next backup. The bucket is
  versioned, so a pruned backup stays recoverable for 30 days. Known cost: the bucket moves backups
  to Glacier IR after 30 days, which bills a 90-day minimum, so backups the count rule deletes early
  are still billed to day 90. Accepted at this scale.
- **Restores download through a presigned S3 URL** for the one backup (read-only, short-lived), not
  STS credentials.
- **A restore replaces the current world** and is refused after an unclean last stop (that world may
  not be in any backup) unless forced.
- **Restore happens in the start workflow, not a workflow of its own:** a restore always needs the
  game stopped and then started. A pending restore arrives in the agent's config, so ordinary starts
  pay nothing; only a start with a restore pending downloads and unpacks a backup first.
- **S3 answers a missing backup with 403, not 404** (see the working agreement), because the link's signer (the config Lambda)
  can't list the bucket. On a 403 the agent fetches a new link once (it may have expired), then
  fails with "no longer exists, or S3 refused the link".
- **A restore whose backup is gone fails the start** (the server ends `FAILED`, world untouched) rather
  than starting without it, so the gap is visible. This can happen when a start fails before
  restoring and the next stop's backup prunes the oldest. `hearth restore` and `--cancel` also accept
  a `FAILED` server whose instance is stopped, so another backup can be chosen.
- **Backup rules live in each game's adapter** (`Backup()` with an exclude list), not in the agent core.
- **The fleet check reports and never fixes** (stuck, failed and mismatched servers, untracked instances).
  It is scheduled in prod only; `hearth fleet-check` runs it anywhere.
- **Game code is not coupled to Minecraft:** one adapter per game under `agent/internal/game/`
  (how to run it), and one set of upload rules per game under `services/repack/src/games/` (how
  to accept a user's upload), both keyed by `GameId`. Game-neutral code and messages never say
  "world" (that's Minecraft's word): uploads, game data, destination. Game-specific code may.
- **Uploads get their own bucket**, not the backups bucket: untrusted content, no versioning, short
  expiry, and browser CORS later. Prefixes: `landing/` (client writes through a presigned link,
  1-day expiry), `accepted/` and `rejected/` (repack writes, 7-day expiry). Repack has no delete
  permission; landing files just expire. The game is in the landing key, which the link signs, so
  a client can't pick another game's rules.
- **User uploads never reach a server as uploaded.** Repack (a throwaway Lambda) unpacks
  them strictly (no `..`, absolute paths or links; a size cap), keeps an allowlist of the game's
  files, and repacks them in our backup format; the agent only restores archives our code made.
  What this can't remove: a deliberately malformed game file still reaches the game's own parser.
  That is contained by the non-root container, one server per instance, and the minimal instance
  role. Lambda limits (10 GB disk, 15 min) cover uploads of a few GB.

## Decided against

- **A shared EC2 events router** (was "PR5"): one account-level rule and Lambda forwarding each event
  to its instance's env. It saves only the duplicate processing above, but every env would depend
  on one component in the account stack, which the dev pipeline deploys: a dev mistake could break
  prod's state sync. Isolation matters more. If volumes ever matter, separate accounts per env.
- **Agent check-ins or heartbeats:** API cost at scale. Push through SSM Run Command instead; M6 idle
  detection runs on the instance.
- **Backing up on OS shutdown:** EC2 may not wait 5 minutes; the SSM stop path is the backup path.
- **Marking a stop FAILED when the SSM path fails but the OS-shutdown save works:** the server is fine.
  Making that fallback visible (record field, metric, alarm) is deferred.
- **Time-based expiry of agent releases or backups:** count-based retention instead.
- **Manual semver tags for agent releases:** date tags are generated automatically.
- **15-minute agent stop window:** 5 minutes; slower means something is wrong.

## Deferred

- **Moving the owner off root credentials** (IAM Identity Center or an admin user; root kept for
  account recovery). Tabled by the owner after prod went live; not a PR.
- **Game version catalog** (now M9; routes move to `/v1`; replaces "create defaults to the latest version").
  - **Today:** `create` only checks a version's format (a typo fails at first start);
    `set-version` checks Mojang's live list (releases, 10-min cache); the image is
    `itzg/minecraft-server` at the unpinned `latest` tag.
  - **Plan:** a per-env `hearth-<env>-GameVersions` table (SSM's 8 KB limit is too small for ~800
    versions): game, version, type (release / old_beta / old_alpha; no snapshots), release date
    (orders forward-only upgrades), **image tag** (from Mojang's per-version Java requirement:
    pins the image), enabled. Import all of Mojang's list; enable 1.7+ only, since the Minecraft
    adapter needs the modern server list ping (1.7+) and RCON. Pre-1.7 needs adapter work (legacy
    ping, save without RCON) before it's enabled.
  - **"Release game version" workflow:** inputs game, version (or `all` for the first import), env.
    Looks the version up in Mojang's live list (refuses unknown, snapshot and pre-1.7), writes it to
    that env's table, enabled; reruns are harmless. Dev first, try it, then stage and prod.
  - **Then:** `GET /admin/games/{game}/versions` (enabled, newest first) for the UI's picker;
    create, set-version and uploads accept only enabled versions; create with no version uses the
    newest enabled release; the agent config takes the version's image tag.
  - **PRs:** V1 table, store and Mojang-to-entry mapping; V2 admin routes (list, add one or all);
    V3 the workflow; V4 create/set-version/config use it. Later: pre-1.7 adapter support.
  - **Owner wants to try it in dev before merging to main:** build on `feature/game-versions` with
    V1–V4 PRed into it; deploy it with Deploy's manual run ("Use workflow from" the branch). While
    dev runs the branch, pause merges to main (a main deploy would revert it and delete the new
    table). A `workflow_dispatch` workflow can't be run until its file is on main: test with the CLI
    first, or merge the workflow file early. Check the GitHub `dev` environment allows that branch.
- **Deleting a user's data for real.** Destroyed servers keep their records and backups, so user
  data is kept by default. Before a public launch (Phase 2 accounts), add a "delete my account and
  data" path that truly deletes records and backups.
- **Version rollback.** Upgrades are one-way (the game converts the world), so `set-version` is
  forward only. Restoring a pre-upgrade backup does *not* put the server back on the old version:
  backups don't record their game version, so the old world would just be upgraded again. To roll
  back properly: record the version on each backup (S3 metadata at upload), have restore set it, and
  show it in `hearth backups`. Until then, rolling back is manual.
- **Game layout facts in one place.** The agent adapter (Go: what to back up) and the upload rules
  (TypeScript: where an upload goes) both know a game's folder layout. Move such facts into
  `packages/shared` as data, sent to the agent in its config, when a second game arrives.
- **Malware scanning of uploads:** GuardDuty Malware Protection for S3 can scan `landing/` files
  (billed per GB). Not needed while uploads are repacked and allowlisted.
- **Checking an upload's game version** (e.g. Minecraft's `level.dat`) against the chosen version;
  until then, the user picks the same or a newer version.
- **Snapshot versions** (the group may want them). Do rollback (above) first: snapshots are where
  worlds break, and forward-only can't step back. Then one small PR: keep snapshots in the version
  list, marked as such (release-date ordering already spans both), opt in with
  `hearth set-version … --snapshot` (maybe `create --snapshot`), and confirm on a test server that
  the Minecraft image takes snapshot IDs in `VERSION`. Players switch their launcher to match.
- **Join/leave events from the game's log** (M6 follow-up). Polling every 15s can miss a visit of a
  few seconds, which shouldn't count as idle. The agent can follow the container's output through
  Docker's API on its local socket (no extra process, unlike `docker logs -f`; a few lines a minute,
  negligible CPU), with the adapter recognising join lines (Minecraft: `… joined the game`). Joins
  reset the idle timer instantly; the poll stays the source of truth for the count, correcting
  anything the log missed or reworded.
- **Agent logs in CloudWatch.** Today they're only in journald (Session Manager:
  `journalctl -u hearth-agent`); CloudWatch has the status reports and Lambda logs. If needed: the
  agent sends its own `info` logs with `PutLogEvents` (no CloudWatch agent daemon, which costs game
  RAM), 14-day retention; a few cents a month. Not the game's own logs (too chatty).
- **Warn when restoring the newest backup after a clean stop:** it's the current world, so nothing
  changes (this confused the first restore test on dev).
- **Telling players about a version change** (their clients must match): a printed reminder or a
  Discord announcement, later.
