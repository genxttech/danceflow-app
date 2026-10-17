<#
.SYNOPSIS
  Checks your filled-in Stage B business file against the exact rules the launcher and runner apply.
  Local only: no Twilio, no database, no network. Prints field names and rules, NEVER your values.

  -Studio <short-name> checks %LOCALAPPDATA%\tw4-validation\private\<short-name>-business.json; or pass -Path <file>.
  There is no default file: the checker only ever reads the one file you name.

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\check-business-file.ps1 -Studio confidance
#>
[CmdletBinding()]
param([string]$Studio, [string]$Path)
$ErrorActionPreference = "Stop"
if (-not $Path) {
  if (-not $Studio) { Write-Host "REFUSED: pass -Studio <short-name> or -Path <file>. There is no default file."; exit 2 }
  if ($Studio -notmatch '^[a-z0-9][a-z0-9-]{1,40}$') { Write-Host "REFUSED: -Studio must be 2-41 characters: lowercase letters, digits and hyphens."; exit 2 }
  $Path = Join-Path $env:LOCALAPPDATA "tw4-validation\private\$Studio-business.json"
}
if ($Path -match '[&|<>^"%!]' -or $Path.TrimStart().StartsWith("-")) { Write-Host "REFUSED: unsafe characters in the path."; exit 2 }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Push-Location $repoRoot
try {
  & npx.cmd tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/check-business.ts $Path
  exit $LASTEXITCODE
}
finally { Pop-Location }
