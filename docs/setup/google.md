# Google sign-in setup

Sets up "Continue with Google" for one environment: a Google OAuth client that Cognito signs users
in through. The owner does this once per environment (dev, stage, prod), in this order:

1. The environment's Auth stack is deployed (its Cognito domain exists).
2. Create its Google OAuth client and save it in Secrets Manager (below).
3. Turn Google on for that environment: add `'google'` to its `SIGN_IN_PROVIDERS` entry in
   `infra/lib/config.ts`, in a PR. Deploying without the secret fails.

## 1. The Google project (once)

In the [Google Cloud console](https://console.cloud.google.com):

1. Create a project, `Hearth`.
2. **Google Auth Platform → Branding:** app name `Hearth`, your support email.
3. **Audience:** **External**. While in **Testing**, only the test users you list can sign in; add
   your group's Google accounts. Publishing later needs no Google verification, as long as only the
   scopes below are used.
4. **Data access:** scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. No others.

## 2. One OAuth client per environment

**Google Auth Platform → Clients → Create client:**

| Field | Value |
| --- | --- |
| Application type | Web application |
| Name | `Hearth <env>` |
| Authorized JavaScript origins | (empty) |
| Authorized redirect URI | `https://hearth-<env>-138300868928.auth.us-west-2.amazoncognito.com/oauth2/idpresponse` |

A client per environment keeps a dev secret from working against prod. When Hearth gets its own
domain, each client's redirect URI changes to that environment's custom sign-in domain.

## 3. Save it in Secrets Manager

From PowerShell. The JSON goes through a file and is deleted after: Windows PowerShell strips the
double quotes from JSON passed straight to `aws`.

```powershell
$Env = 'dev'
@{ clientId = '<client id>'; clientSecret = '<client secret>' } | ConvertTo-Json -Compress |
  Set-Content -Encoding ascii -NoNewline google-secret.json
aws secretsmanager create-secret --region us-west-2 --name "hearth/$Env/google" --secret-string file://google-secret.json
Remove-Item google-secret.json
```

CloudFormation reads it at deploy; it never appears in code or templates. To rotate: create a new
secret in Google, `aws secretsmanager put-secret-value` (same file approach), then redeploy the Auth
stack (merge anything to `main` for dev, or promote the current release for stage and prod).
Cost: about $0.40 a month per secret.

## 4. Check it

[docs/testing/sign-in.md](../testing/sign-in.md), "Google".
