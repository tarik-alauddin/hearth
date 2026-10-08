# Sign-in check

Checks that an environment's Cognito user pool signs a user in through its managed login pages and
issues tokens: with a password, Google and Discord. Rerun after changes to the Auth stack.

**Where to run:** PowerShell on your own machine (Windows PowerShell or `pwsh`), from the repo
root, with AWS credentials for the account; plus a browser. `scripts/sign-in-check.ps1` does the
sign-in the way the CLI will: opens the sign-in page, catches the callback on
`http://localhost:8976/callback`, exchanges the code (with PKCE), shows the ID token's claims and
checks a refresh. **Costs:** none at this scale.

If PowerShell refuses to run scripts ("running scripts is disabled"), run it as shown below
(`-ExecutionPolicy Bypass` applies to that one run only).

## 0. Before you start

- The change is deployed (for dev: merged to `main`, Deploy workflow green; stage and prod: promoted).

```powershell
$Env = 'dev'
$Auth = aws ssm get-parameter --region us-west-2 --name "/hearth/$Env/auth" --query Parameter.Value --output text | ConvertFrom-Json
$Auth
$Pool = $Auth.userPoolId
```

Expect `region`, `userPoolId`, `issuer`, `domain`, `cliClientId`, and on dev also `webClientId`.

## 1. Create your user (once per environment)

```powershell
$Email = 'you@example.com'
aws cognito-idp admin-create-user --region us-west-2 --user-pool-id $Pool --username $Email `
  --user-attributes "Name=email,Value=$Email" "Name=email_verified,Value=true"
aws cognito-idp admin-add-user-to-group --region us-west-2 --user-pool-id $Pool --username $Email --group-name admin
```

Expect an email from `no-reply@verificationemail.com` with a temporary password (check spam). Keep
the quotes around `Name=…,Value=…`: unquoted, PowerShell reads the comma as a list.

## 2. Sign in with a password

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -Env $Env
```

1. The browser opens the managed login page: email and password only, **no "Sign up" link**.
2. Sign in. The first time, use the temporary password, then set your own (12+ characters, upper
   and lower case, a digit and a symbol).
3. The tab says "Done"; back in PowerShell, expect:
   - `email` your address, `email_verified True`, `provider password (Cognito)`, `groups admin`
   - `Refresh: OK (new ID and access tokens).`

To check the web app's client too (dev only): add `-Client web`.

## 3. Sign out

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -Env $Env -SignOut
```

Expect `Signed out`. Running step 2 again now asks for your password.

## 4. Google

For environments with Google on (`signInProviders` in `infra/lib/config.ts`; setup:
[docs/setup/google.md](../setup/google.md)).

1. Sign out (step 3), then run step 2 again: the page now has **Continue with Google**. Close it
   (the script gives up after 5 minutes, or press Ctrl+C).
2. Sign in with Google directly (in Testing mode, with one of the app's test users):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -Env $Env -Provider Google
   ```

   Expect your Gmail `email`, `email_verified True`, your `name` and `picture`, `provider Google`,
   `groups (none)`: a new user, separate from your password user (Cognito doesn't link them).
3. Make it an admin with its `user` (`Google_…`) from the output, then run 2 again: `groups admin`.

   ```powershell
   aws cognito-idp admin-add-user-to-group --region us-west-2 --user-pool-id $Pool --username 'Google_<number>' --group-name admin
   ```

## 5. Discord

For environments with Discord on (setup: [docs/setup/discord.md](../setup/discord.md)). Sign out
first (step 3).

1. Run step 2: the page now has a **Discord** button beside Google. Close it.
2. Sign in with Discord directly; Discord asks you to authorize Hearth the first time:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -Env $Env -Provider Discord
   ```

   Expect `provider Discord`, your Discord `username` and `display_name`, an avatar URL in
   `picture`, your Discord account's `email` and `email_verified`, `groups (none)`: another
   separate user.
3. Make it an admin with its `user` (`Discord_…`), as for Google, then run 2 again: `groups admin`.

## If something goes wrong

| What you see | Why, and what to do |
| --- | --- |
| No temporary password email | Resend: step 1's `admin-create-user` with `--message-action RESEND` |
| Cognito page: "redirect_mismatch" or "invalid client" | The env's Auth stack isn't the deployed one; check step 0's values |
| `Sign-in failed: …` | The error Cognito returned, e.g. a provider not on for this env |
| Discord: "Invalid OAuth2 redirect_uri" | The Discord app's Redirects list lacks this env's `…/oauth2/idpresponse` |
| Cognito page after Discord: an error mentioning the token or attributes | Cognito couldn't use Discord's response; send the message and the script's output (the fallback is a wrapper λ) |
| `Timed out after 5 minutes` | The browser never came back; run it again |
| Port 8976 already in use | Another sign-in script (or later, `hearth login`) is still waiting; close it |
