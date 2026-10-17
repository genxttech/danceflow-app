$ErrorActionPreference = "Continue"
# Portable paths: everything is relative to this file; scratch output goes to %TEMP%\tw4-launcher-tests.
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sp = Join-Path $env:TEMP "tw4-launcher-tests"; New-Item -ItemType Directory -Force $sp | Out-Null
$hereFwd = $here -replace '\\', '/'
$spFwd = $sp -replace '\\', '/'
$launcher = "$repo\scripts\tw4-validation\run-stage-a.ps1"
$reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
$S = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"          # synthetic 32-character secret
$ACC = "AC" + ("1" * 32); $SK = "SK" + ("2" * 32)
$results = New-Object System.Collections.Generic.List[string]

# rewrite the wrapper so the fake clipboard hands out queued lines (the last one repeats)
Set-Content -Path "$sp\wrap_launcher.ps1" -Encoding ascii -Value @'
param([string]$Launcher, [string]$Out, [string]$ClipFile, [string]$SetLog)
$global:TWCLIP = @(); if (Test-Path $ClipFile) { $global:TWCLIP = @([IO.File]::ReadAllLines($ClipFile)) }
$global:TWCI = 0; $global:TWLOG = $SetLog
function Get-Clipboard { param([switch]$Raw) Add-Content -Path $global:TWLOG -Value "Get-Clipboard called"; if ($global:TWCLIP.Count -eq 0) { return $null }; $v = $global:TWCLIP[[Math]::Min($global:TWCI, $global:TWCLIP.Count - 1)]; $global:TWCI++; return $v }
function Set-Clipboard { param($Value) Add-Content -Path $global:TWLOG -Value ("Set-Clipboard called; value is null: " + ($null -eq $Value)) }
& $Launcher -DryRun -Interactive *>&1 | Out-File -FilePath $Out -Encoding utf8
Add-Content -Path $Out -Value ("WRAPPER_EXIT=" + $LASTEXITCODE)
'@

function Run-Scenario {
  param([string]$Name, [string[]]$Steps, [string[]]$ClipLines = @(), [int]$ExpectExit, [string[]]$Expect = @(), [string[]]$Forbid = @(), [switch]$ExpectClear, [switch]$ExpectReport)
  if ($env:ENTRY_ONLY -and $Name -notlike "*$($env:ENTRY_ONLY)*") { return }
  $out = "$sp\sc_out.txt"; $clip = "$sp\sc_clip.txt"; $setlog = "$sp\sc_setlog.txt"
  Remove-Item $out, $clip, $setlog -ErrorAction SilentlyContinue
  if ($ClipLines.Count -gt 0) { [IO.File]::WriteAllLines($clip, $ClipLines) }
  $before = if (Test-Path $reportDir) { @(Get-ChildItem $reportDir -Filter "selftest-*.json" | ForEach-Object Name) } else { @() }
  $child = Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$sp\wrap_launcher.ps1`"", "-Launcher", "`"$launcher`"", "-Out", "`"$out`"", "-ClipFile", "`"$clip`"", "-SetLog", "`"$setlog`"" -PassThru -WindowStyle Minimized
  $stepsFile = "$sp\sc_steps.json"; ConvertTo-Json -InputObject @($Steps) | Set-Content -Path $stepsFile -Encoding ascii
  $inj = Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$here\inject.ps1`"", "-TargetPid", $child.Id, "-StepsFile", "`"$stepsFile`"" -PassThru -WindowStyle Minimized
  $finished = $child.WaitForExit(45000)
  if (-not $finished) { $child.Kill() }
  [void]$inj.WaitForExit(20000); if (-not $inj.HasExited) { $inj.Kill() }
  $text = if (Test-Path $out) { Get-Content $out -Raw } else { "" }
  $log = if (Test-Path $setlog) { Get-Content $setlog -Raw } else { "" }
  $exit = if ($text -match 'WRAPPER_EXIT=(\d+)') { [int]$Matches[1] } else { -1 }
  $problems = @()
  if (-not $finished) { $problems += "TIMED OUT" }
  if ($exit -ne $ExpectExit) { $problems += "exit $exit (expected $ExpectExit)" }
  foreach ($e in $Expect) { if ($text -notlike "*$e*") { $problems += "missing: $e" } }
  foreach ($f in $Forbid + @($S)) { if ($text -like "*$f*") { $problems += "OUTPUT CONTAINS FORBIDDEN TEXT ($($f.Length) chars)" } }
  $new = @((Get-ChildItem $reportDir -Filter "selftest-*.json" -ErrorAction SilentlyContinue | ForEach-Object Name) | Where-Object { $before -notcontains $_ })
  if ($ExpectReport -and $new.Count -ne 1) { $problems += "expected 1 report, got $($new.Count)" }
  if (-not $ExpectReport -and $new.Count -ne 0) { $problems += "unexpected report" }
  foreach ($file in $new) { $body = Get-Content (Join-Path $reportDir $file) -Raw; if ($body -like "*$S*") { $problems += "REPORT CONTAINS SECRET" }; Remove-Item (Join-Path $reportDir $file) -Force }
  if ($ExpectClear -and $log -notlike "*value is null: True*") { $problems += "clipboard was not cleared" }
  if (-not $ExpectClear -and $log -like "*Set-Clipboard called*") { $problems += "clipboard was cleared unexpectedly" }
  if ($text -notlike "*Credentials cleared from this process*") { $problems += "no 'Credentials cleared' line" }
  $script:results.Add(("{0,-44} {1}" -f $Name, $(if ($problems.Count -eq 0) { "PASS" } else { "FAIL: " + ($problems -join "; ") })))
  if ($problems.Count -gt 0) { $script:results.Add("   ---- captured output ----`n$text`n   ---- set log: $log") }
}

$tail = @("text:y", "enter")
Run-Scenario "Ctrl+V (key press) for the secret" (@("text:$ACC", "enter", "text:$SK", "enter", "ctrlv", "enter") + $tail) -ClipLines @($S) -ExpectExit 0 -Expect @("32 characters received", "Clipboard cleared", "Stage A completed cleanly") -ExpectClear -ExpectReport
Run-Scenario "right-click paste = 32-char burst" (@("text:$ACC", "enter", "text:$SK", "enter", "burst:$S", "enter") + $tail) -ExpectExit 0 -Expect @("32 characters received") -ExpectReport
Run-Scenario "bracketed-paste burst (ESC[200~ ... ESC[201~)" (@("text:$ACC", "enter", "text:$SK", "enter", "bracketed:$S", "enter") + $tail) -ExpectExit 0 -Expect @("32 characters received") -ExpectReport
Run-Scenario "Enter on empty secret reads the clipboard" (@("text:$ACC", "enter", "text:$SK", "enter", "enter") + $tail) -ClipLines @($S) -ExpectExit 0 -Expect @("read from the clipboard", "32 characters received", "Clipboard cleared") -ExpectClear -ExpectReport
Run-Scenario "clipboard text with spaces/tab is trimmed" (@("text:$ACC", "enter", "text:$SK", "enter", "ctrlv", "enter") + $tail) -ClipLines @("  $S`t ") -ExpectExit 0 -Expect @("32 characters received") -ExpectClear -ExpectReport
Run-Scenario "typed 34 chars then 2 Backspaces" (@("text:$ACC", "enter", "text:$SK", "enter", "burst:${S}zz", "bs", "bs", "enter") + $tail) -ExpectExit 0 -Expect @("32 characters received") -ExpectReport
Run-Scenario "all three entries via Ctrl+V" (@("ctrlv", "enter", "ctrlv", "enter", "ctrlv", "enter") + $tail) -ClipLines @($ACC, $SK, $S) -ExpectExit 0 -Expect @("32 characters received", "Clipboard cleared") -ExpectClear -ExpectReport
Run-Scenario "short clipboard is rejected (3 tries)" @("text:$ACC", "enter", "text:$SK", "enter", "ctrlv", "enter", "ctrlv", "enter", "ctrlv", "enter") -ClipLines @("short1234") -ExpectExit 2 -Expect @("has 9 characters", "nothing was sent to Twilio")
Run-Scenario "Ctrl+V with empty clipboard = empty, not '1 char'" @("text:$ACC", "enter", "text:$SK", "enter", "ctrlv", "enter", "ctrlv", "enter", "ctrlv", "enter") -ExpectExit 2 -Expect @("The secret is empty") -Forbid @("has 1 characters")
Run-Scenario "Esc cancels the secret prompt" @("text:$ACC", "enter", "text:$SK", "enter", "esc") -ExpectExit 2 -Expect @("Cancelled by you (Esc)")
$results
