# Sign-in check

Checks that an environment's Cognito user pool signs a user in through its managed login pages
and issues tokens. Rerun after changes to the Auth stack. Google and Discord sections join this
guide as those providers are added.

**Where to run:** your own terminal (Git Bash on Windows: prefix AWS commands with
`MSYS_NO_PATHCONV=1`, as the parameter names start with `/`) or AWS CloudShell in `us-west-2`,
plus a browser. **Costs:** none at this scale.

## 0. Before you start

- The change is deployed (for dev: merged to `main`, Deploy workflow green; stage and prod: promoted).
- An authenticator app on your phone (Google Authenticator, 1Password, Authy…): password users
  must set up TOTP on their first sign-in.

```bash
ENV=dev
AUTH=$(aws ssm get-parameter --name "/hearth/$ENV/auth" --query Parameter.Value --output text)
echo "$AUTH"
POOL=$(echo "$AUTH" | jq -r .userPoolId)
DOMAIN=$(echo "$AUTH" | jq -r .domain)
CLIENT=$(echo "$AUTH" | jq -r .cliClientId)
```

Expect `region`, `userPoolId`, `issuer`, `domain`, `cliClientId`, and on dev also `webClientId`.

## 1. Create your user (once per environment)

```bash
EMAIL=you@example.com
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$EMAIL" --group-name admin
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
3. Scan the QR code into your authenticator app and enter its code.
4. The browser goes to `http://localhost:8976/callback?code=…` and shows "can't connect": expected,
   nothing listens there until `hearth login` exists. Copy the `code` value from the address bar.

## 3. Exchange the code for tokens

Within 5 minutes (codes are single-use and short-lived):

```bash
CODE=<the code>
TOKENS=$(curl -s -X POST "$DOMAIN/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code -d client_id="$CLIENT" -d code="$CODE" \
  -d redirect_uri=http://localhost:8976/callback)
echo "$TOKENS" | jq 'keys'
echo "$TOKENS" | jq -r .id_token | node -e \
  "process.stdin.on('data', t => console.log(JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url'))))"
```

- Expect `access_token`, `expires_in`, `id_token`, `refresh_token`, `token_type`.
- The ID token's claims show your `email` and `cognito:groups: [ 'admin' ]`. Decode tokens
  locally like this; don't paste them into websites.

## 4. Refresh

```bash
curl -s -X POST "$DOMAIN/oauth2/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token -d client_id="$CLIENT" \
  -d refresh_token="$(echo "$TOKENS" | jq -r .refresh_token)" | jq 'keys'
```

Expect new `access_token` and `id_token` (no new refresh token).

## 5. Sign out

```bash
echo "$DOMAIN/logout?client_id=$CLIENT&logout_uri=http://localhost:8976/callback"
```

Open it: the browser goes to the callback ("can't connect" again). Opening the sign-in URL from
step 2 now asks for your password again.
