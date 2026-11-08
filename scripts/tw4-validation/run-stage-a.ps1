<#
.SYNOPSIS
  TW-4 Stage A launcher: prompts for three Twilio credentials, validates them, runs the READ-ONLY probe once, clears them.

.DESCRIPTION
  Stage A sends GET requests only (no resources, no fees). This launcher:
    - asks for the Account SID, the API key SID and the API key secret. The secret is read by a custom hidden reader (asterisks only,
      never echoed) that works with every way of pasting: Ctrl+V and Shift+Insert (read from the clipboard), right-click paste and
      typed input. Pressing Enter on an EMPTY secret prompt also reads the secret from the clipboard. Read-Host -AsSecureString is NOT
      used for this because Windows PowerShell 5.1 stores a Ctrl+V key press as one literal control character (1 character, 1 asterisk);
    - validates their shape locally BEFORE anything is sent (prefixes, lengths, character set) and says what to correct;
    - writes the report to a NEW timestamped file under %LOCALAPPDATA%\tw4-validation\reports (never overwrites);
    - sets the credentials as environment variables for the child process only, and removes them in a finally block;
    - clears the clipboard afterwards if (and only if) it still holds the secret that was read from it;
    - never writes credentials to disk, to a transcript, to the console or to the report.
  -DryRun is a COMPLETE, NON-INTERACTIVE self-test: it uses built-in synthetic credentials (it never prompts, never reads your real
  credentials), runs the same validation, launcher and CLI against canned data, writes a report marked "selfTest": true, and clears
  everything. NO network, NO Twilio contact.
  -DryRun -Interactive is the same canned-data, no-network self-test but with the REAL prompts, to test the entry path itself.
  -CompareLegal additionally asks for the legal name and EIN you expect on the Primary profile (compared only; never printed).
  With -DryRun (without -Interactive) it uses synthetic values instead of asking.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\run-stage-a.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\run-stage-a.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Interactive,
  [switch]$CompareLegal
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
Set-PSDebug -Off

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$EnvNames = @("TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_AUTH_TOKEN", "TW4_VALIDATION_EXPECTED_NAME", "TW4_VALIDATION_EXPECTED_EIN")
$script:ClipboardTextUsed = $null   # the text read from the clipboard for the secret, kept only to clear the clipboard afterwards

if ($Interactive -and -not $DryRun) { Write-Host "REFUSED (exit code 2): -Interactive is only meaningful together with -DryRun (it self-tests the prompts against canned data)." -ForegroundColor Yellow; exit 2 }
$UseDryRunDefaults = $DryRun -and -not $Interactive

# Test seam: ONLY honoured with -DryRun and not -Interactive (so it can never feed real credentials to a real run).
function Get-TestInput([string]$Name) {
  if ($UseDryRunDefaults) { return [Environment]::GetEnvironmentVariable($Name) }
  return $null
}

# Built-in synthetic values used by -DryRun when nothing else is supplied. They are not real Twilio credentials.
$DryRunDefaults = @{
  Account = "AC" + ("0" * 32)
  KeySid  = "SK" + ("0" * 32)
  Secret  = "selftestselftestselftestselftest"
}

# Shared hidden-entry and validation helpers (also used by run-stage-b.ps1).
. (Join-Path $PSScriptRoot "launcher-common.ps1")

$exitCode = 2
$secretPlain = $null
$expectedEin = $null
try {
  Write-Host ""
  if ($DryRun -and -not $Interactive) {
    Write-Host "DRY RUN (self-test): built-in synthetic credentials and canned data. No prompts, no network, no Twilio contact." -ForegroundColor Cyan
  }
  elseif ($DryRun) {
    Write-Host "DRY RUN, INTERACTIVE (self-test of the prompts): type or paste any synthetic values. Canned data only; no network, no Twilio contact." -ForegroundColor Cyan
  }
  else { Write-Host "TW-4 Stage A: READ-ONLY Twilio probe (GET requests only; creates nothing, costs nothing)." -ForegroundColor Cyan }
  if (-not $UseDryRunDefaults) { Write-Host "Credentials are typed here, kept in this process only, and cleared at the end. Nothing is saved to disk." }
  Write-Host ""

  if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) { throw "REFUSED (exit code 2), nothing was sent to Twilio. node_modules is missing under $RepoRoot; run npm install there first." }
  if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { throw "REFUSED (exit code 2), nothing was sent to Twilio. Node.js (npx) was not found on PATH." }

  $accountSid = Read-Validated -Prompt "Account SID (AC...)" -TestVar "TW4_LAUNCHER_TEST_ACCOUNT" -DryDefault $DryRunDefaults.Account -Check { param($v) Test-Sid $v "AC" "The Account SID" }
  $keySid = Read-Validated -Prompt "API key SID (SK...)" -TestVar "TW4_LAUNCHER_TEST_KEY_SID" -DryDefault $DryRunDefaults.KeySid -Check { param($v) Test-Sid $v "SK" "The API key SID" }
  $secretPlain = Read-Validated -Prompt "API key secret (hidden)" -TestVar "TW4_LAUNCHER_TEST_KEY_SECRET" -DryDefault $DryRunDefaults.Secret -Secret -Check {
    param($v)
    if ($v.Length -eq 0) { return "The secret is empty (nothing was typed and the clipboard held no text)." }
    if ($v.Length -ne 32) { return "The secret has $($v.Length) characters; Twilio API key secrets have 32. Part of it may be missing or extra text was pasted." }
    if ($v -notmatch '^[A-Za-z0-9]{32}$') { return "The secret contains characters other than letters and digits." }
    return $null
  }
  if ($accountSid -eq $keySid) { throw "REFUSED (exit code 2), nothing was sent to Twilio. The Account SID and the API key SID are the same value." }

  $expectedName = $null
  if ($CompareLegal -and $UseDryRunDefaults) {
    $expectedName = "Self Test LLC"; $expectedEin = "000000000" # synthetic; matches the canned Primary profile
  }
  elseif ($CompareLegal) {
    $expectedName = Read-LineInput -Prompt "Exact legal name on the Primary profile (compared only)"
    $expectedEin = Read-LineInput -Prompt "EIN (hidden, compared only)" -Hidden
  }

  $reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $prefix = if ($DryRun) { "selftest-stage-a" } else { "tw4-stage-a" }
  $reportPath = Join-Path $reportDir "$prefix-$stamp.json"
  $n = 1
  while (Test-Path $reportPath) { $n++; $reportPath = Join-Path $reportDir "$prefix-$stamp-$n.json" }

  Write-Host ""
  Write-Host ("Account {0}...{1}   key {2}...{3}   report: {4}" -f $accountSid.Substring(0, 2), $accountSid.Substring(30), $keySid.Substring(0, 2), $keySid.Substring(30), $reportPath)
  $answer = Get-TestInput "TW4_LAUNCHER_TEST_CONFIRM"
  if (-not $answer -and $UseDryRunDefaults) { $answer = "y" } # nothing real can happen in a dry run
  if (-not $answer) { $answer = Read-Host "Run the $(if ($DryRun) { 'self-test' } else { 'read-only probe' }) now? (y/N)" }
  if ($answer -notmatch '^(y|yes)$') { throw "Cancelled by you; nothing was sent." }

  # environment for the CHILD process only; removed again in the finally block
  foreach ($name in $EnvNames) { [Environment]::SetEnvironmentVariable($name, $null, "Process") }
  $env:TWILIO_ACCOUNT_SID = $accountSid
  $env:TWILIO_API_KEY_SID = $keySid
  $env:TWILIO_API_KEY_SECRET = $secretPlain
  if ($expectedName) { $env:TW4_VALIDATION_EXPECTED_NAME = $expectedName }
  if ($expectedEin) { $env:TW4_VALIDATION_EXPECTED_EIN = $expectedEin }

  $cliArgs = @("tsx", "--tsconfig", "scripts/tw4-validation/tsconfig.json", "scripts/tw4-validation/stage-a.ts", "--confirm-stage-a-read-only", "--out", $reportPath)
  if ($DryRun) { $cliArgs += "--self-test" }

  Push-Location $RepoRoot
  try {
    $ErrorActionPreference = "Continue" # native stderr lines must not become terminating errors
    & npx.cmd @cliArgs
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = "Stop"
    Pop-Location
  }

  Write-Host ""
  switch ($exitCode) {
    0 { Write-Host "Stage A completed cleanly." -ForegroundColor Green; Write-Host "Report: $reportPath" }
    1 { Write-Host "Stage A ran but reported problems (listed above). The report was still written:" -ForegroundColor Yellow; Write-Host "Report: $reportPath" }
    2 { Write-Host "Stage A was REFUSED before any request; the reason is printed above. No report was written." -ForegroundColor Yellow }
    default { Write-Host "Stage A ended with exit code $exitCode." -ForegroundColor Yellow }
  }
}
catch {
  $exitCode = 2
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Yellow
}
finally {
  if ($secretPlain) { Clear-ClipboardIfItHolds $secretPlain }
  foreach ($name in $EnvNames) { [Environment]::SetEnvironmentVariable($name, $null, "Process") }
  $secretPlain = $null
  $expectedEin = $null
  $script:ClipboardTextUsed = $null
  [GC]::Collect()
  $cleared = -not ($EnvNames | Where-Object { [Environment]::GetEnvironmentVariable($_, "Process") })
  if ($cleared) { Write-Host "Credentials cleared from this process." } else { Write-Host "WARNING: some credential variables could not be cleared; close this window." -ForegroundColor Red }
  if (-not $DryRun) { Write-Host "Reminder: revoke the temporary API key in the Twilio Console when you are done." }
}
exit $exitCode
