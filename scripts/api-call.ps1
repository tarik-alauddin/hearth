<#
.SYNOPSIS
  Calls a /v1 route as a signed-in user, for trying the user API before the CLI and web app use
  it. Signs in through the browser the first time (scripts/lib/hearth-auth.ps1), then keeps the
  session in ~/.hearth/script-session-<env>.json: the ID token is refreshed when it expires, and
  the browser opens again only when the refresh token does (30 days).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\api-call.ps1 /v1/me
  powershell -ExecutionPolicy Bypass -File scripts\api-call.ps1 /v1/me -Provider Google
  powershell -ExecutionPolicy Bypass -File scripts\api-call.ps1 -Method POST /v1/servers -Body '{"game":"minecraft-java","version":"26.3"}'
  powershell -ExecutionPolicy Bypass -File scripts\api-call.ps1 -SignOut
#>
param(
  [Parameter(Position = 0)] [string] $Path,
  [ValidateSet('GET', 'POST', 'PATCH', 'DELETE')] [string] $Method = 'GET',
  # A JSON request body.
  [string] $Body,
  [ValidateSet('dev', 'stage', 'prod')] [string] $Env = 'dev',
  # Sign in with this provider (Google, Discord) instead of the page's choice; signs in again.
  [string] $Provider,
  # Forget the saved session (the next call signs in again).
  [switch] $SignOut
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\lib\hearth-auth.ps1"

$sessionFile = Join-Path $HOME ".hearth\script-session-$Env.json"
if ($SignOut) {
  Remove-Item $sessionFile -ErrorAction SilentlyContinue
  Write-Host "Forgot the $Env session." -ForegroundColor Green
  return
}
if (-not $Path) { throw 'Give a path, e.g. /v1/me' }

$auth = Get-HearthAuth $Env
$clientId = $auth.cliClientId
$redirect = 'http://localhost:8976/callback'

# An ID token with a minute to spare: the saved one, a refreshed one, or a new sign-in.
$session = $null
if (-not $Provider -and (Test-Path $sessionFile)) { $session = Get-Content -Raw $sessionFile | ConvertFrom-Json }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
if ($session -and (Read-Jwt $session.id_token).exp -gt $now + 60) {
  $idToken = $session.id_token
} else {
  $tokens = $null
  if ($session.refresh_token) {
    try {
      $tokens = Invoke-HearthRefresh $auth $clientId $session.refresh_token
      $tokens | Add-Member -NotePropertyName refresh_token -NotePropertyValue $session.refresh_token -Force
    } catch {
      Write-Host 'The saved session has expired; signing in again.'
    }
  }
  if (-not $tokens) { $tokens = Invoke-HearthSignIn $auth $clientId $redirect $Provider }
  New-Item -ItemType Directory -Force (Split-Path $sessionFile) | Out-Null
  @{ id_token = $tokens.id_token; refresh_token = $tokens.refresh_token } | ConvertTo-Json | Set-Content -Encoding ascii $sessionFile
  $idToken = $tokens.id_token
}

$apiUrl = aws ssm get-parameter --region us-west-2 --name "/hearth/$Env/api-url" --query Parameter.Value --output text
if ($LASTEXITCODE -ne 0) { throw "Could not read /hearth/$Env/api-url" }

$request = @{
  Method          = $Method
  Uri             = "$apiUrl$Path"
  Headers         = @{ Authorization = "Bearer $idToken" }
  UseBasicParsing = $true
}
if ($Body) {
  $request.Body = $Body
  $request.ContentType = 'application/json'
}
try {
  $response = Invoke-WebRequest @request
  $status = [int] $response.StatusCode
  $content = $response.Content
} catch [System.Net.WebException] {
  # Windows PowerShell throws on 4xx and 5xx; the answer is still worth showing. It has usually
  # read the body already (into ErrorDetails), leaving the response stream empty.
  $status = [int] $_.Exception.Response.StatusCode
  $content = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else {
    (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd()
  }
}

$color = if ($status -lt 400) { 'Green' } else { 'Yellow' }
Write-Host "$Method $Path -> $status" -ForegroundColor $color
if ($content) {
  try { $content | ConvertFrom-Json | ConvertTo-Json -Depth 10 } catch { $content }
}
