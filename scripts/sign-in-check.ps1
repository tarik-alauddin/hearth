<#
.SYNOPSIS
  Signs in to an environment's Cognito user pool through its managed login page, as the CLI and
  web app will: opens the browser, catches the callback on localhost, exchanges the code (with
  PKCE), shows the ID token's claims and checks a refresh. See docs/testing/sign-in.md.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1
  powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -Provider Google
  powershell -ExecutionPolicy Bypass -File scripts\sign-in-check.ps1 -SignOut
#>
param(
  [ValidateSet('dev', 'stage', 'prod')] [string] $Env = 'dev',
  # Which app client to sign in as: the CLI's, or the web app's (dev only).
  [ValidateSet('cli', 'web')] [string] $Client = 'cli',
  # Skip the provider buttons and go straight to one (e.g. Google).
  [string] $Provider,
  # Sign out of the managed login session instead of signing in.
  [switch] $SignOut
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib\hearth-auth.ps1"

$auth = Get-HearthAuth $Env
if ($Client -eq 'cli') {
  $clientId = $auth.cliClientId
  $redirect = 'http://localhost:8976/callback'
} else {
  if (-not $auth.webClientId) { throw "$Env has no web client." }
  $clientId = $auth.webClientId
  $redirect = 'http://localhost:5173/auth/callback'
}
$callback = [Uri] $redirect
Write-Host "$Env user pool $($auth.userPoolId), $Client client $clientId"

if ($SignOut) {
  Start-Process "$($auth.domain)/logout?client_id=$clientId&logout_uri=$([Uri]::EscapeDataString($redirect))"
  Wait-Callback $callback.Port $callback.AbsolutePath | Out-Null
  Write-Host 'Signed out: the next sign-in asks for your password again (Google may still remember you).' -ForegroundColor Green
  return
}

$tokens = Invoke-HearthSignIn $auth $clientId $redirect $Provider
$claims = Read-Jwt $tokens.id_token

Write-Host "`nSigned in. ID token:" -ForegroundColor Green
$provider = 'password (Cognito)'
if ($claims.identities) { $provider = @($claims.identities)[0].providerName }
$groups = '(none)'
if ($claims.'cognito:groups') { $groups = $claims.'cognito:groups' -join ', ' }
[pscustomobject]@{
  user           = $claims.'cognito:username' # what admin commands take
  sub            = $claims.sub
  email          = $claims.email
  email_verified = $claims.email_verified
  name           = $claims.name               # Google
  username       = $claims.preferred_username # Discord
  display_name   = $claims.nickname           # Discord
  picture        = $claims.picture
  provider       = $provider
  groups         = $groups
  expires        = ([DateTimeOffset]::FromUnixTimeSeconds($claims.exp)).LocalDateTime
} | Format-List

$refreshed = Invoke-HearthRefresh $auth $clientId $tokens.refresh_token
if ($refreshed.id_token -and $refreshed.access_token) {
  Write-Host 'Refresh: OK (new ID and access tokens).' -ForegroundColor Green
} else {
  throw 'Refresh returned no tokens.'
}
