# Discord sign-in setup

Sets up the "Discord" sign-in button for one environment: a Discord application that Cognito signs
users in through, as an OpenID Connect provider. The owner does this once per environment (dev,
stage, prod), in this order:

1. The environment's Auth stack is deployed (its Cognito domain exists).
2. Create its Discord application and save it in Secrets Manager (below).
3. Turn Discord on for that environment: add `'discord'` to its `SIGN_IN_PROVIDERS` entry in
   `infra/lib/config.ts`, in a PR. Deploying without the secret fails.

## 1. One Discord application per environment

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application**, named `Hearth <env>` (users see "Hearth dev wants to access your account";
   prod's could be just `Hearth`).
2. **General Information:** optionally an app icon and description (shown on the authorize screen).
3. **OAuth2:**
   - Copy the **Client ID**.
   - **Client Secret → Reset Secret**, and copy it (shown once).
   - **Redirects → Add Redirect:**
     `https://hearth-<env>-138300868928.auth.us-west-2.amazoncognito.com/oauth2/idpresponse`, then
     **Save Changes**.

Separate apps keep a dev secret from working against prod. Discord has no testing mode: anyone
with the sign-in link can authorize it, which is fine, as a new user can do nothing until approved.
When Hearth gets its own domain, each app's redirect changes to that environment's sign-in domain.

## 2. Save it in Secrets Manager

From PowerShell. The JSON goes through a file and is deleted after: Windows PowerShell strips the
double quotes from JSON passed straight to `aws`.

```powershell
$Env = 'dev'
@{ clientId = '<client id>'; clientSecret = '<client secret>' } | ConvertTo-Json -Compress |
  Set-Content -Encoding ascii -NoNewline discord-secret.json
aws secretsmanager create-secret --region us-west-2 --name "hearth/$Env/discord" --secret-string file://discord-secret.json
Remove-Item discord-secret.json
```

CloudFormation reads it at deploy; it never appears in code or templates. To rotate: **Reset
Secret** in Discord, `aws secretsmanager put-secret-value` (same file approach), then redeploy the
Auth stack (merge anything to `main` for dev, or promote the current release for stage and prod).
Cost: about $0.40 a month per secret.

## What Hearth gets from Discord

Scopes `openid identify email`. Mapped onto the Cognito user: `email`, `email_verified`, the
username (`preferred_username`), the display name (`nickname`) and the avatar URL (`picture`).

## 3. Check it

[docs/testing/sign-in.md](../testing/sign-in.md), "Discord".
