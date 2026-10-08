# Sign-in check

Checks that an environment's Cognito user pool signs a user in through its managed login pages
and issues tokens, with a password (steps 1–5) and with Google (step 6). Rerun after changes to
the Auth stack.

**Where to run:** your own terminal or AWS CloudShell in `us-west-2`, plus a browser. Git Bash on
Windows: prefix AWS commands with `MSYS_NO_PATHCONV=1` (the parameter names start with `/`). JSON is
read with Node (`jq` isn't in Git Bash; and there, `node` is a `winpty` alias that can't take piped
input, so the helper calls `node.exe`). **Costs:** none at this scale.

## 0. Before you start

- The change is deployed (for dev: merged to `main`, Deploy workflow green; stage and prod: promoted).

```bash
# js '<json>' '<expression on j>': reads a JSON value without jq or pipes.
NODE=$(command -v node.exe || command -v node)
js() { J="$1" "$NODE" -p "const j = JSON.parse(process.env.J); $2"; }

ENV=dev
AUTH=$(aws ssm get-parameter --region us-west-2 --name "/hearth/$ENV/auth" --query Parameter.Value --output text)
echo "$AUTH"
POOL=$(js "$AUTH" j.userPoolId)
DOMAIN=$(js "$AUTH" j.domain)
CLIENT=$(js "$AUTH" j.cliClientId)
```

Expect `region`, `userPoolId`, `issuer`, `domain`, `cliClientId`, and on dev also `webClientId`.

## 1. Create your user (once per environment)

```bash
EMAIL=you@example.com
aws cognito-idp admin-create-user --region us-west-2 --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --region us-west-2 --user-pool-id "$POOL" --username "$EMAIL" --group-name admin
```

Expect an email from Cognito with a temporary password (check spam).

## 2. Sign in

Open this URL in a browser:

```bash
echo "$DOMAIN/oauth2/authorize?client_id=$CLIENT&response_type=code&scope=openid+email+profile&redirect_uri=http://localhost:8976/callback"
```

1. The managed login page shows email and password only: **no "Sign up" link**.
2. Sign in with the temporary password; set a new one (12+ characters, upper and lower case, a
   digit and a symbol).
3. The browser goes to `http://localhost:8976/callback?code=…` and shows "can't connect": expected,
   nothing listens there until `hearth login` exists. Copy the `code` value from the address bar.

## 3. Exchange the code for tokens

Within 5 minutes (codes are single-use and short-lived):

```bash
CODE=<the code>
TOKENS=$(curl -s -X POST "$DOMAIN/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code -d client_id="$CLIENT" -d code="$CODE" \
  -d redirect_uri=http://localhost:8976/callback)
js "$TOKENS" 'j.error ?? Object.keys(j)'
js "$TOKENS" "JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url'))"
```

- Expect `access_token`, `expires_in`, `id_token`, `refresh_token`, `token_type`. `invalid_grant`
  instead = the code was used or expired: sign in again (step 2) for a new one.
- The ID token's claims show your `email` and `cognito:groups: [ 'admin' ]`. Decode tokens
  locally like this; don't paste them into websites.

## 4. Refresh

```bash
REFRESHED=$(curl -s -X POST "$DOMAIN/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token -d client_id="$CLIENT" -d refresh_token="$(js "$TOKENS" j.refresh_token)")
js "$REFRESHED" 'j.error ?? Object.keys(j)'
```

Expect new `access_token` and `id_token` (no new refresh token).

## 5. Sign out

```bash
echo "$DOMAIN/logout?client_id=$CLIENT&logout_uri=http://localhost:8976/callback"
```

Open it: the browser goes to the callback ("can't connect" again). Opening the sign-in URL from
step 2 now asks for your password again.

## 6. Google

For environments with Google on (`signInProviders` in `infra/lib/config.ts`; setup:
[docs/setup/google.md](../setup/google.md)). Sign out first (step 5), so the page doesn't reuse
your password session.

1. Open the sign-in URL from step 2: the page now has **Continue with Google**. Choose it and pick
   your Google account (in Testing mode, it must be one of the app's test users).
2. Back at the callback, exchange the code as in step 3. The ID token shows your Gmail `email`,
   `email_verified: true`, `name`, `picture`, and an `identities` claim with
   `providerName: 'Google'`. No `cognito:groups`: this is a new user, separate from your password
   user (Cognito doesn't link them).
3. Make that user an admin too. Its username is in the token's `cognito:username`
   (`google_<number>`):

```bash
GOOGLE_USER=google_<number>
aws cognito-idp admin-add-user-to-group --region us-west-2 --user-pool-id "$POOL" \
  --username "$GOOGLE_USER" --group-name admin
```

Sign in with Google again: the new ID token has `cognito:groups: [ 'admin' ]`.
