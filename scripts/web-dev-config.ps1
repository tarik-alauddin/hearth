<#
.SYNOPSIS
  Writes apps/web/config.local.json from SSM, so the web app's dev server (pnpm --filter
  @hearth/web dev, on http://localhost:5173) signs in and calls an environment's API, as the
  deployed site does with its config.json. Only dev's web client accepts localhost as a callback.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\web-dev-config.ps1
#>
param(
  [ValidateSet('dev', 'stage', 'prod')] [string] $Env = 'dev',
  [string] $Region = 'us-west-2'
)
$ErrorActionPreference = 'Stop'

$apiUrl = aws ssm get-parameter --name "/hearth/$Env/api-url" --region $Region --query Parameter.Value --output text
if ($LASTEXITCODE -ne 0) { throw "Could not read /hearth/$Env/api-url" }
$authJson = aws ssm get-parameter --name "/hearth/$Env/auth" --region $Region --query Parameter.Value --output text
if ($LASTEXITCODE -ne 0) { throw "Could not read /hearth/$Env/auth" }
$auth = $authJson | ConvertFrom-Json

$config = [ordered]@{
  env    = $Env
  apiUrl = $apiUrl.TrimEnd('/')
  auth   = [ordered]@{ region = $Region; domain = $auth.domain; clientId = $auth.webClientId }
}
$path = Join-Path $PSScriptRoot '..\apps\web\config.local.json'
# UTF-8 without a BOM (Windows PowerShell's -Encoding utf8 adds one).
[System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($path), ($config | ConvertTo-Json -Depth 3))
Write-Host "Wrote $path for $Env. Now: pnpm --filter @hearth/web dev"
