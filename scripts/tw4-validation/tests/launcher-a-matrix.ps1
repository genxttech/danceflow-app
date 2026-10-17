$ErrorActionPreference = "Continue"
# Portable paths: everything is relative to this file; scratch output goes to %TEMP%\tw4-launcher-tests.
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sp = Join-Path $env:TEMP "tw4-launcher-tests"; New-Item -ItemType Directory -Force $sp | Out-Null
$hereFwd = $here -replace '\\', '/'
$spFwd = $sp -replace '\\', '/'
$launcher = "$repo\scripts\tw4-validation\run-stage-a.ps1"
$secret = ("a1B2" * 8)
$reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
$results = @()

function Run-Case([string]$Name, [hashtable]$Over, [switch]$Real, [int]$ExpectExit, [string[]]$ExpectText, [string[]]$ForbidText = @(), [switch]$ExpectReport) {
  $before = if (Test-Path $reportDir) { @(Get-ChildItem $reportDir -Filter "*.json" | ForEach-Object Name) } else { @() }
  $vars = @{
    TW4_LAUNCHER_TEST_ACCOUNT = "AC" + ("1" * 32); TW4_LAUNCHER_TEST_KEY_SID = "SK" + ("2" * 32)
    TW4_LAUNCHER_TEST_KEY_SECRET = $secret; TW4_LAUNCHER_TEST_CONFIRM = "y"
  }
  foreach ($k in $Over.Keys) { $vars[$k] = $Over[$k] }
  foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k], "Process") }
  if ($Real) {
    $out = cmd /c "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcher`" < NUL 2>&1" | Out-String
  } else {
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher -DryRun 2>&1 | Out-String
  }
  $code = $LASTEXITCODE
  foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $null, "Process") }
  $after = if (Test-Path $reportDir) { @(Get-ChildItem $reportDir -Filter "*.json" | ForEach-Object Name) } else { @() }
  $new = @($after | Where-Object { $before -notcontains $_ })
  $problems = @()
  if ($code -ne $ExpectExit) { $problems += "exit $code (expected $ExpectExit)" }
  foreach ($t in $ExpectText) { if ($out -notlike "*$t*") { $problems += "missing text: $t" } }
  foreach ($t in $ForbidText + @($secret)) { if ($out -like "*$t*") { $problems += "OUTPUT CONTAINS FORBIDDEN TEXT" } }
  if ($ExpectReport -and $new.Count -ne 1) { $problems += "expected exactly one new report, got $($new.Count)" }
  if (-not $ExpectReport -and $new.Count -ne 0) { $problems += "unexpected new report" }
  foreach ($file in $new) {
    $body = Get-Content (Join-Path $reportDir $file) -Raw
    if ($body -like "*$secret*" -or $body -like "*SK$("2" * 32)*") { $problems += "REPORT CONTAINS CREDENTIAL" }
    if ($body -notlike '*"selfTest": true*') { $problems += "report not marked selfTest" }
    Remove-Item (Join-Path $reportDir $file) -Force
  }
  if ($out -notlike "*Credentials cleared*" -and -not $Real) { $problems += "no 'Credentials cleared' line" }
  $status = if ($problems.Count -eq 0) { "PASS" } else { "FAIL: " + ($problems -join "; ") }
  $script:results += "{0,-34} exit={1} {2}" -f $Name, $code, $status
}

Run-Case "dry run ok" @{} -ExpectExit 0 -ExpectText @("DRY RUN", "Stage A completed cleanly", "Credentials cleared") -ExpectReport
Run-Case "surrounding spaces trimmed" @{ TW4_LAUNCHER_TEST_KEY_SECRET = "  $secret  " } -ExpectExit 0 -ExpectText @("surrounding spaces were removed") -ExpectReport
Run-Case "account/key swapped" @{ TW4_LAUNCHER_TEST_ACCOUNT = "SK" + ("1" * 32) } -ExpectExit 2 -ExpectText @("looks like an API key SID", "nothing was sent")
Run-Case "key sid is an AC" @{ TW4_LAUNCHER_TEST_KEY_SID = "AC" + ("2" * 32) } -ExpectExit 2 -ExpectText @("looks like an Account SID")
Run-Case "short sid" @{ TW4_LAUNCHER_TEST_ACCOUNT = "AC" + ("1" * 10) } -ExpectExit 2 -ExpectText @("has 12 characters")
Run-Case "short secret" @{ TW4_LAUNCHER_TEST_KEY_SECRET = "short" } -ExpectExit 2 -ExpectText @("has 5 characters")
Run-Case "secret with symbols" @{ TW4_LAUNCHER_TEST_KEY_SECRET = ("a1B!" * 8) } -ExpectExit 2 -ExpectText @("other than letters and digits")
Run-Case "account equals key" @{ TW4_LAUNCHER_TEST_KEY_SID = "SK" + ("1" * 32); TW4_LAUNCHER_TEST_ACCOUNT = "AC" + ("1" * 32) } -ExpectExit 0 -ExpectText @("Stage A completed cleanly") -ExpectReport
Run-Case "operator cancels" @{ TW4_LAUNCHER_TEST_CONFIRM = "n" } -ExpectExit 2 -ExpectText @("Cancelled by you; nothing was sent")
Run-Case "real mode ignores test seam" @{} -Real -ExpectExit 2 -ExpectText @() -ForbidText @("Stage A completed", "Report written")
$results
