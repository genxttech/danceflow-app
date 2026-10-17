<#
.SYNOPSIS
  Creates a PRIVATE copy of the Stage B business-file template OUTSIDE the repository, readable only by you.
  No network, no Twilio, no database. Refuses to overwrite an existing file.

.DESCRIPTION
  Default location: %LOCALAPPDATA%\tw4-validation\private\genx-business.json
  Fill it in with any editor, then run check-business-file.ps1 on it. The EIN does NOT go in this file: the launcher asks for it
  in a hidden prompt when it runs. Never paste the contents of this file into a chat.

  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\new-business-file.ps1
#>
[CmdletBinding()]
param([string]$Path)
$ErrorActionPreference = "Stop"
$template = Join-Path $PSScriptRoot "stage-b-business.template.json"
if (-not $Path) { $Path = Join-Path $env:LOCALAPPDATA "tw4-validation\private\genx-business.json" }
$repo = ((Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path.TrimEnd('\') + '\').ToLowerInvariant()
$full = [IO.Path]::GetFullPath($Path)
if (($full.ToLowerInvariant()).StartsWith($repo)) { Write-Host "REFUSED: that path is inside the repository. Choose a folder outside it."; exit 2 }
if (Test-Path -LiteralPath $full) { Write-Host "REFUSED: $full already exists; it was not touched. Edit it, or pass -Path with a new name."; exit 2 }
$dir = Split-Path -Parent $full
New-Item -ItemType Directory -Force $dir | Out-Null
# folder readable by the current user only (inherit removed), so the copy is private even on a shared machine
& icacls.exe $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: could not restrict the folder permissions; keep this file private yourself." }
Copy-Item -LiteralPath $template -Destination $full
Write-Host "Created: $full"
Write-Host "Next:    1. Open it in an editor and replace every <placeholder> (the EIN is NOT in this file)."
Write-Host "         2. powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\check-business-file.ps1 -Path `"$full`""
exit 0
