<#
.SYNOPSIS
  Self-test for Build-ReleaseAab.ps1's path handling and fail-closed exit, with NO build, NO keystore and NO real key.

.DESCRIPTION
  Runs `Build-ReleaseAab.ps1 -CheckOnly` from a DIFFERENT working directory with RELATIVE -ExpectedFile and -Aab, against a
  throwaway QA-signed AAB (the harness/QA build, never the owner's). Expected: the script resolves the relative paths against
  the caller's directory, the signer check rejects the QA key, the baked-config verifier actually RUNS on the expected file
  (it reports rule failures for the QA placeholders, not "file not found"), the exit code is 1 and "DO NOT UPLOAD" is printed.

.EXAMPLE
  .\docs\mobile\tools\Test-BuildReleaseAabPaths.ps1 -QaAab C:\dfr-out\release\<qa-signed>.aab
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$QaAab)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$script = Join-Path $here "Build-ReleaseAab.ps1"
$expected = Join-Path $here "expected-production.student.json"
$QaAab = (Resolve-Path -LiteralPath $QaAab).Path

# A different cwd, so a relative path is only valid if resolved against the caller's directory.
$cwd = Join-Path $env:TEMP ("bra-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $cwd | Out-Null
Copy-Item -LiteralPath $expected -Destination (Join-Path $cwd "exp.json")
Copy-Item -LiteralPath $QaAab -Destination (Join-Path $cwd "qa.aab")
$ok = $true
function Check($name, $cond) { if ($cond) { Write-Host "ok   $name" } else { Write-Host "BAD  $name"; $script:ok = $false } }

Push-Location $cwd
try {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -App student -CheckOnly -Aab ".\qa.aab" -ExpectedFile ".\exp.json" 2>&1 | Out-String
  $code = $LASTEXITCODE
} finally { Pop-Location; Remove-Item -Recurse -Force $cwd -ErrorAction SilentlyContinue }

Check "exit code is 1 (fail-closed) for a QA-signed AAB" ($code -eq 1)
Check "prints DO NOT UPLOAD" ($out -match "DO NOT UPLOAD")
Check "signer check rejects the QA key" ($out -match "QA-ONLY")
Check "relative -Aab was found (no 'needs -Aab')" ($out -notmatch "needs -Aab")
Check "relative -ExpectedFile was found (no 'Missing file')" ($out -notmatch "Missing file")
Check "verifier ran on the expected file (no ENOENT / cannot read)" ($out -notmatch "ENOENT|no such file|Cannot find|cannot read")
Check "verifier reported rule failures for the QA build" ($out -match "FAIL|placeholder|10\.0\.2\.2|\.invalid")
if (-not $ok) { Write-Host "`n--- captured output ---`n$out"; exit 1 }
Write-Host "`nSELF-TEST PASS"
exit 0
