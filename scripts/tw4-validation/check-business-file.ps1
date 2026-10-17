<#
.SYNOPSIS
  Checks your filled-in Stage B business file against the exact rules the launcher and runner apply.
  Local only: no Twilio, no database, no network. Prints field names and rules, NEVER your values.

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\check-business-file.ps1 [-Path <file>]
#>
[CmdletBinding()]
param([string]$Path)
$ErrorActionPreference = "Stop"
if (-not $Path) { $Path = Join-Path $env:LOCALAPPDATA "tw4-validation\private\genx-business.json" }
if ($Path -match '[&|<>^"%!]' -or $Path.TrimStart().StartsWith("-")) { Write-Host "REFUSED: unsafe characters in the path."; exit 2 }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Push-Location $repoRoot
try {
  & npx.cmd tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/check-business.ts $Path
  exit $LASTEXITCODE
}
finally { Pop-Location }
