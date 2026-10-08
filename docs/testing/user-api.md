# User API check

Checks the `/v1` routes, which signed-in users call with the ID token from signing in (the web app
will, and the CLI from M8 PR7). Each part of M8 PR5 adds a section. Rerun after changes to the
user routes, the User Lambda or the Auth stack.

**Where to run:** PowerShell on your own machine, from the repo root, with AWS credentials for the
account; plus a browser. `scripts/api-call.ps1` signs you in the first time (like
`scripts/sign-in-check.ps1`), keeps the session in `~/.hearth/script-session-<env>.json`, and
calls a route with your ID token. **Costs:** none at this scale.

```powershell
function api { powershell -ExecutionPolicy Bypass -File scripts\api-call.ps1 @args }
```

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
