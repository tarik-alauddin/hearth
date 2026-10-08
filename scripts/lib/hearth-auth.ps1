# Signing in to an environment's Cognito user pool from PowerShell, as the CLI and web app will:
# the browser opens the managed login page, the callback is caught on localhost, and the code is
# exchanged with PKCE. Dot-sourced by scripts/sign-in-check.ps1 and scripts/api-call.ps1.

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

# The environment's user pool, domain and client IDs (SSM /hearth/<env>/auth).
function Get-HearthAuth([string] $env) {
  $json = aws ssm get-parameter --region us-west-2 --name "/hearth/$env/auth" --query Parameter.Value --output text
  if ($LASTEXITCODE -ne 0) { throw "Could not read /hearth/$env/auth (AWS credentials? Is the Auth stack deployed?)" }
  $json | ConvertFrom-Json
}

# Signs in through the browser and returns the tokens (id_token, access_token, refresh_token, …).
function Invoke-HearthSignIn($auth, [string] $clientId, [string] $redirect, [string] $provider) {
  $callback = [Uri] $redirect
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
  if ($provider) { $query += "&identity_provider=$provider" }
  Write-Host 'Opening the sign-in page in your browser...'
  Start-Process "$($auth.domain)/oauth2/authorize?$query"

  $result = Wait-Callback $callback.Port $callback.AbsolutePath
  if ($result['error']) { throw "Sign-in failed: $($result['error']) $($result['error_description'])" }
  if ($result['state'] -ne $state) { throw 'The callback came back with a different state: not this sign-in.' }

  Invoke-RestMethod -Method Post -Uri "$($auth.domain)/oauth2/token" -ContentType 'application/x-www-form-urlencoded' -Body @{
    grant_type    = 'authorization_code'
    client_id     = $clientId
    code          = $result['code']
    redirect_uri  = $redirect
    code_verifier = $verifier
  }
}

# New ID and access tokens from a refresh token (Cognito returns no new refresh token).
function Invoke-HearthRefresh($auth, [string] $clientId, [string] $refreshToken) {
  Invoke-RestMethod -Method Post -Uri "$($auth.domain)/oauth2/token" -ContentType 'application/x-www-form-urlencoded' -Body @{
    grant_type    = 'refresh_token'
    client_id     = $clientId
    refresh_token = $refreshToken
  }
}
