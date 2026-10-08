# User API check

Checks the `/v1` routes, which signed-in users call with the ID token from signing in (the web app
will, and the CLI from M8 PR7). Each part of M8 PR5 adds a section. Rerun after changes to the
user routes, the User Lambda or the Auth stack.

**Where to run:** PowerShell on your own machine, from the repo root, with AWS credentials for the
account; plus a browser. `scripts/api-call.ps1` signs you in the first time (like
`scripts/sign-in-check.ps1`), keeps the session in `~/.hearth/script-session-<env>.json`, and
calls a route with your ID token. **Costs:** none at this scale.

Once per PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass   # lets this window run the repo's scripts; nothing else
function api { & .\scripts\api-call.ps1 @args }
```

The script runs in the same session, not through `powershell -File …`: Windows PowerShell strips
the double quotes from arguments it passes to another process, so a JSON `-Body` would arrive as
`{approved:true}` (the script now refuses that before sending).

`api -SignOut` forgets the saved session; `api /v1/me -Provider Google` (or `Discord`) signs in
again with that provider, as a different user.

## 1. Who am I (`GET /v1/me`)

```powershell
api /v1/me
```

1. The first time, the browser opens the sign-in page; sign in (the tab then says "Done").
2. Expect `GET /v1/me -> 200` and you: `userId` (your `sub`), `admin: true` for a user in the
   `admin` group, `approved: false` and `serverLimit: 3` (new users wait for approval),
   `provider`, `email`, `createdAt`.
3. Run it again: it answers straight away (the saved session), with the same `createdAt`.
4. Sign in with another provider (`api /v1/me -Provider Discord`): a separate user, its own
   `userId`, with your Discord `username`, `displayName` and `picture`; `admin` only if that
   user is in the `admin` group.

Check the Users table recorded them:

```powershell
aws dynamodb scan --region us-west-2 --table-name hearth-dev-Users --query 'Items[].[userId.S, provider.S, approved.BOOL]' --output table
```

And that the API refuses calls without a valid ID token (API Gateway answers before Hearth does):

```powershell
$url = aws ssm get-parameter --region us-west-2 --name /hearth/dev/api-url --query Parameter.Value --output text
try { Invoke-WebRequest "$url/v1/me" -UseBasicParsing } catch { [int] $_.Exception.Response.StatusCode }
try { Invoke-WebRequest "$url/v1/me" -Headers @{ Authorization = 'Bearer nonsense' } -UseBasicParsing } catch { [int] $_.Exception.Response.StatusCode }
```

Expect `401` twice.

## 2. Approve a user (`POST /v1/admin/users/{id}/approval`)

Admins only. Users are approved by their user ID: the `userId` `/v1/me` shows them (their Cognito
`sub`). Someone signed in with several providers is several users; approve each one they use.

1. As your non-admin user (a provider whose user isn't in `admin`; ask a friend for theirs, or use
   one of yours), note its `userId` from `api /v1/me`. Try approving yourself with it:

   ```powershell
   api -Method POST /v1/admin/users/<userId>/approval -Body '{"approved":true}'
   ```

   Expect `403` ("not a Hearth admin"), and `approved` still `false` in its `/v1/me`.
2. Sign in as your admin user again (`api -SignOut`, then any call) and run the same command: expect
   `200` with the user's record, `approved: true` and `approvedAt`. Their `/v1/me` now says
   `approved: true`.
3. Take it back with `-Body '{"approved":false}'`: `approved: false`, no `approvedAt`.
4. A user ID that has never signed in answers `404`; a body like `{"approved":"yes"}` answers `400`.

## 3. My servers (`GET /v1/servers`, `GET /v1/servers/{id}`)

Answers are the UI's view of a server (`ServerView`): its status, version, `address` while it runs,
and the caller's `role` (owner, member, or admin). Never instance IDs or storage keys, for admins
either; admins keep the whole record on `/admin`. Until `/v1` can create servers (M8 PR5d), nobody
owns one through it, so the list is empty; the CLI's servers (created through `/admin`) are what
admins can look at.

1. `api /v1/servers`: expect `200` and `{"servers": []}` (`-Body` isn't needed; add `?all=true` to
   the path to include destroyed servers).
2. Pick a server ID from `pnpm hearth list` and, as your admin user, `api /v1/servers/<id>`: expect
   `200` with `role: admin`, its `status`, `version`, `idleStopMinutes`, and **no** `instanceId`,
   `volumeId` or `lastBackupKey`.
3. The same as a user outside `admin`: expect `404` ("No server …"), exactly as for an ID that
   doesn't exist (`api /v1/servers/01NOSUCHSERVER0000000000`).
