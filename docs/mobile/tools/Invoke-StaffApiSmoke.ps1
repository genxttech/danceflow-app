<#
.SYNOPSIS
  One command: authenticated, READ-ONLY smoke of the production staff API (https://www.idanceflow.com/api/staff).

.DESCRIPTION
  Runs staff-api-prod-smoke.mjs in this console. The script itself asks, with hidden input, for the email and password of your own
  owner/admin/front-desk account (or, with -Otp, the email and the code that arrives by email), signs in with Supabase and makes only
  GET requests. This wrapper never sees the credentials: nothing is passed through arguments, environment variables or files.
  The access token stays in that one node process's memory and is discarded when it ends.

  It reads only the PUBLIC EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY from -PublicEnv (never printed) and saves a
  redacted summary (no names, emails, ids or tokens) to -Out. Build-ReleaseAab.ps1 reads that summary before it enables the
  Pulse and Studio-day screens.

  Run it in a normal PowerShell or Windows Terminal window (the hidden prompt needs a real console; not the ISE).

.EXAMPLE
  C:\Dev\studioapp\docs\mobile\tools\Invoke-StaffApiSmoke.ps1
.EXAMPLE
  # an account with no password (email-code sign-in only)
  C:\Dev\studioapp\docs\mobile\tools\Invoke-StaffApiSmoke.ps1 -Otp
#>
[CmdletBinding()]
param(
  [switch]$Otp,
  [string]$PublicEnv = "C:\Users\mcurt\df-credentials\release\business.env",
  [string]$Out = "C:\dfr-out\release\checks\business-staff-smoke.txt"
)
$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node is not on PATH." }
if ($Host.Name -match "ISE") { throw "Run this in a normal PowerShell or Windows Terminal window, not the ISE (hidden prompts need a real console)." }
$PublicEnv = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PublicEnv)
$Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
if (-not (Test-Path -LiteralPath $PublicEnv)) { throw "Missing file: $PublicEnv" }

$script = Join-Path $PSScriptRoot "staff-api-prod-smoke.mjs"
$nodeArgs = @($script, "--public-env", $PublicEnv, "--out", $Out)
if ($Otp) { $nodeArgs += "--otp" }

Write-Host "Production staff API smoke: GET only, https://www.idanceflow.com. You will be asked for your staff email and password (hidden)." -ForegroundColor Cyan
& node @nodeArgs
$code = $LASTEXITCODE
switch ($code) {
  0 { Write-Host "SMOKE: PASS. Summary: $Out" -ForegroundColor Green }
  1 { Write-Host "SMOKE: FAIL (see the FAIL lines above). Summary: $Out" -ForegroundColor Red }
  default { Write-Host "SMOKE: did not run to the end (exit $code). Nothing was called after sign-in failed." -ForegroundColor Red }
}
exit $code
