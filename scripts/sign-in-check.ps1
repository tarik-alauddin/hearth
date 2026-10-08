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

function Base64Url([byte[]] $bytes) {
  [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-Jwt([string] $token) {
  $part = $token.Split('.')[1].Replace('-', '+').Replace('_', '/')
  switch ($part.Length % 4) { 2 { $part += '==' } 3 { $part += '=' } }
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
}

# Waits for the browser to come back to the loopback callback and returns the request's query.
# Listens on both 127.0.0.1 and ::1, as browsers may resolve localhost to either.
function Wait-Callback([int] $port, [string] $path) {
  $listeners = @(
    [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port),
    [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Loopback, $port)
  )
  foreach ($l in $listeners) { $l.Start() }
  try {
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
      foreach ($l in $listeners) {
        if (-not $l.Pending()) { continue }
        $socket = $l.AcceptTcpClient()
        try {
          $stream = $socket.GetStream()
          $reader = New-Object IO.StreamReader($stream)
          $requestLine = $reader.ReadLine() # GET /callback?code=... HTTP/1.1
          $target = $requestLine.Split(' ')[1]
          $body = '<!doctype html><title>Hearth</title><p style="font-family:sans-serif">Done. You can close this tab and go back to PowerShell.</p>'
          $response = "HTTP/1.1 200 OK`r`nContent-Type: text/html; charset=utf-8`r`nContent-Length: $([Text.Encoding]::UTF8.GetByteCount($body))`r`nConnection: close`r`n`r`n$body"
          $bytes = [Text.Encoding]::UTF8.GetBytes($response)
          $stream.Write($bytes, 0, $bytes.Length)
          $stream.Flush()
        } finally { $socket.Close() }
        if (-not $target.StartsWith($path)) { continue } # e.g. the browser asking for /favicon.ico
        $query = @{}
        $qs = ''
        if ($target.Contains('?')) { $qs = $target.Substring($target.IndexOf('?') + 1) }
        foreach ($pair in $qs.Split('&')) {
          if (-not $pair) { continue }
          $kv = $pair.Split('=', 2)
          $query[[Uri]::UnescapeDataString($kv[0])] = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) } else { '' }
        }
        return $query
      }
      Start-Sleep -Milliseconds 200
    }
    throw 'Timed out after 5 minutes waiting for the browser to come back.'
  } finally {
    foreach ($l in $listeners) { $l.Stop() }
  }
}

$authJson = aws ssm get-parameter --region us-west-2 --name "/hearth/$Env/auth" --query Parameter.Value --output text
if ($LASTEXITCODE -ne 0) { throw "Could not read /hearth/$Env/auth (AWS credentials? Is the Auth stack deployed?)" }
$auth = $authJson | ConvertFrom-Json
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

# PKCE: proves the code is exchanged by whoever started the sign-in.
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$buffer = New-Object byte[] 32
$rng.GetBytes($buffer)
$verifier = Base64Url $buffer
$challenge = Base64Url ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier)))
$rng.GetBytes($buffer)
$state = Base64Url $buffer

$query = "client_id=$clientId&response_type=code&scope=openid+email+profile" +
  "&redirect_uri=$([Uri]::EscapeDataString($redirect))&state=$state" +
  "&code_challenge=$challenge&code_challenge_method=S256"
if ($Provider) { $query += "&identity_provider=$Provider" }
Write-Host 'Opening the sign-in page in your browser...'
Start-Process "$($auth.domain)/oauth2/authorize?$query"

$result = Wait-Callback $callback.Port $callback.AbsolutePath
if ($result['error']) { throw "Sign-in failed: $($result['error']) $($result['error_description'])" }
if ($result['state'] -ne $state) { throw 'The callback came back with a different state: not this sign-in.' }

$tokens = Invoke-RestMethod -Method Post -Uri "$($auth.domain)/oauth2/token" -ContentType 'application/x-www-form-urlencoded' -Body @{
  grant_type    = 'authorization_code'
  client_id     = $clientId
  code          = $result['code']
  redirect_uri  = $redirect
  code_verifier = $verifier
}
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

$refreshed = Invoke-RestMethod -Method Post -Uri "$($auth.domain)/oauth2/token" -ContentType 'application/x-www-form-urlencoded' -Body @{
  grant_type    = 'refresh_token'
  client_id     = $clientId
  refresh_token = $tokens.refresh_token
}
if ($refreshed.id_token -and $refreshed.access_token) {
  Write-Host 'Refresh: OK (new ID and access tokens).' -ForegroundColor Green
} else {
  throw 'Refresh returned no tokens.'
}
