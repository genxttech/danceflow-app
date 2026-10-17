$ErrorActionPreference = "Continue"
# Portable paths: everything is relative to this file; scratch output goes to %TEMP%\tw4-launcher-tests.
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sp = Join-Path $env:TEMP "tw4-launcher-tests"; New-Item -ItemType Directory -Force $sp | Out-Null
$hereFwd = $here -replace '\\', '/'
$spFwd = $sp -replace '\\', '/'
$launcher = "$repo\scripts\tw4-validation\run-stage-b.ps1"
$reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
$S = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"      # synthetic 32-character secret (clipboard / typed)
$ACC = "AC" + ("1" * 32); $SK = "SK" + ("2" * 32)
$EIN = "98-7654321"
$results = New-Object System.Collections.Generic.List[string]
$tmp = Join-Path $env:TEMP "tw4-bentry"; New-Item -ItemType Directory -Force $tmp | Out-Null
$biz = Join-Path $tmp "business.json"
'{"legal_name":"Entry Test LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow","website_url":"","address_line1":"1 Way","address_line2":"","city":"Portland","region":"OR","postal_code":"97201","rep_first_name":"A","rep_last_name":"B","rep_title":"Owner","rep_position":"ceo","rep_email":"a@example.test","rep_phone":"(503) 555-0100","preferred_area_code":"503"}' | Set-Content -LiteralPath $biz -Encoding ascii
function Db([string]$sql) { (docker exec supabase_db_danceflow-e2e-qa psql -U postgres -At -c $sql) -join "" }

# wrapper: runs the real Stage B launcher (-DryRun -Interactive) in THIS console with fake clipboard cmdlets (the user's clipboard is never touched)
Set-Content -Path "$sp\wrap_launcher_b.ps1" -Encoding ascii -Value @'
param([string]$Launcher, [string]$Out, [string]$ClipFile, [string]$SetLog)
$global:TWCLIP = @(); if (Test-Path $ClipFile) { $global:TWCLIP = @([IO.File]::ReadAllLines($ClipFile)) }
$global:TWCI = 0; $global:TWLOG = $SetLog
function Get-Clipboard { param([switch]$Raw) Add-Content -Path $global:TWLOG -Value "Get-Clipboard called"; if ($global:TWCLIP.Count -eq 0) { return $null }; $v = $global:TWCLIP[[Math]::Min($global:TWCI, $global:TWCLIP.Count - 1)]; $global:TWCI++; return $v }
function Set-Clipboard { param($Value) Add-Content -Path $global:TWLOG -Value ("Set-Clipboard called; value is null: " + ($null -eq $Value)) }
& $Launcher -DryRun -Interactive *>&1 | Out-File -FilePath $Out -Encoding utf8
Add-Content -Path $Out -Value ("WRAPPER_EXIT=" + $LASTEXITCODE)
'@

function Run-Scenario {
  param([string]$Name, [string[]]$Steps, [string[]]$ClipLines = @(), [int]$ExpectExit, [string[]]$Expect = @(), [string[]]$Forbid = @(), [switch]$ExpectClear, [switch]$ExpectReports, [switch]$ReportOnly, [switch]$ExpectStudioKept, [int]$TimeoutSec = 150)
  if ($env:ENTRY_ONLY -and $Name -notlike "*$($env:ENTRY_ONLY)*") { return }
  $out = "$sp\scb_out.txt"; $clip = "$sp\scb_clip.txt"; $setlog = "$sp\scb_setlog.txt"; $stepsFile = "$sp\scb_steps.json"
  Remove-Item $out, $clip, $setlog -ErrorAction SilentlyContinue
  if ($ClipLines.Count -gt 0) { [IO.File]::WriteAllLines($clip, $ClipLines) }
  ConvertTo-Json -InputObject @($Steps) | Set-Content -Path $stepsFile -Encoding ascii
  $before = @(Get-ChildItem $reportDir -Filter "selftest-stage-b*" -ErrorAction SilentlyContinue | ForEach-Object Name)
  $child = Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$sp\wrap_launcher_b.ps1`"", "-Launcher", "`"$launcher`"", "-Out", "`"$out`"", "-ClipFile", "`"$clip`"", "-SetLog", "`"$setlog`"" -PassThru -WindowStyle Minimized
  $inj = Start-Process powershell.exe -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$here\inject.ps1`"", "-TargetPid", $child.Id, "-StepsFile", "`"$stepsFile`"", "-DelayBeforeMs", "6000" -PassThru -WindowStyle Minimized
  $finished = $child.WaitForExit($TimeoutSec * 1000)
  if (-not $finished) { $child.Kill() }
  [void]$inj.WaitForExit(30000); if (-not $inj.HasExited) { $inj.Kill() }
  $text = if (Test-Path $out) { Get-Content $out -Raw } else { "" }
  $log = if (Test-Path $setlog) { Get-Content $setlog -Raw } else { "" }
  $exit = if ($text -match 'WRAPPER_EXIT=(\d+)') { [int]$Matches[1] } else { -1 }
  $problems = @()
  if (-not $finished) { $problems += "TIMED OUT" }
  if ($exit -ne $ExpectExit) { $problems += "exit $exit (expected $ExpectExit)" }
  foreach ($e in $Expect) { if ($text -notlike "*$e*") { $problems += "missing: $e" } }
  foreach ($f in $Forbid + @($S, $EIN, $EIN.Replace("-", ""))) { if ($text -like "*$f*") { $problems += "OUTPUT CONTAINS FORBIDDEN TEXT ($($f.Length) chars)" } }
  $new = @((Get-ChildItem $reportDir -Filter "selftest-stage-b*" -ErrorAction SilentlyContinue | ForEach-Object Name) | Where-Object { $before -notcontains $_ })
  if ($ExpectReports -and $new.Count -ne 2) { $problems += "expected report + evidence, got $($new.Count)" }
  if ($ReportOnly -and $new.Count -ne 1) { $problems += "expected only the report (cleanup was declined), got $($new.Count)" }
  if (-not $ExpectReports -and -not $ReportOnly -and $new.Count -ne 0) { $problems += "unexpected report files" }
  foreach ($file in $new) { $body = Get-Content (Join-Path $reportDir $file) -Raw; if ($body -like "*$S*" -or $body -like "*987654321*") { $problems += "REPORT/EVIDENCE CONTAINS A SECRET" }; Remove-Item (Join-Path $reportDir $file) -Force }
  if ($ExpectClear -and $log -notlike "*value is null: True*") { $problems += "clipboard was not cleared" }
  if (-not $ExpectClear -and $log -like "*Set-Clipboard called*") { $problems += "clipboard cleared unexpectedly" }
  if ($text -notlike "*Credentials cleared from this process*") { $problems += "no 'Credentials cleared' line" }
  $left = "studios=" + (Db "select count(*) from public.studios where id::text like '7a1d0000-%'")
  if ($ExpectStudioKept) {
    if ($left -ne "studios=1") { $problems += "expected the local studio to be KEPT, found $left" }
    if (@(Get-ChildItem $env:TEMP -Filter "tw4-stage-b-*.key*" -ErrorAction SilentlyContinue).Count -lt 1) { $problems += "expected the key file to be kept" }
    [void](Db "delete from public.studios where id::text like '7a1d0000-%'")
  }
  elseif ($left -ne "studios=0") { $problems += "LEFTOVER STATE: $left"; [void](Db "delete from public.studios where id::text like '7a1d0000-%'") }
  $script:results.Add(("{0,-58} {1}" -f $Name, $(if ($problems.Count -eq 0) { "PASS" } else { "FAIL: " + ($problems -join "; ") })))
  if ($problems.Count -gt 0) { $script:results.Add("   ---- captured output ----`n$text`n   ---- set log: $log") }
}

$front = @("text:$ACC", "enter", "text:$SK", "enter")
$tailOk = @("text:y", "enter", "wait:50000", "text:y", "enter")        # seed? y ... (seed+checks+run take ~35 s) ... cleanup? y
# 1 happy path: secret by Ctrl+V (clipboard), email typed + CONFIRMED, EIN typed hidden, business path typed
Run-Scenario "secret via Ctrl+V; full flow to a clean stage B and cleanup" ($front + @("ctrlv", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:987654321", "enter", "text:$biz", "enter") + $tailOk) -ClipLines @($S) -ExpectExit 0 -Expect @("32 characters received", "Clipboard cleared", "Stage B ended cleanly at its step limit (S10)", "Local fixtures removed", "Check passed: the real Stage B authorization refuses") -ExpectClear -ExpectReports
# 2 secret as a right-click-style burst; EIN via burst; business path via burst
Run-Scenario "secret and EIN as pasted bursts" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "burst:$EIN", "enter", "burst:$biz", "enter") + $tailOk) -ExpectExit 0 -Expect @("32 characters received", "Stage B ended cleanly") -ExpectReports
# 3 mailbox NOT confirmed: refused before anything is seeded
Run-Scenario "mailbox not confirmed (typed 'yes'): refused before seeding" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:yes", "enter")) -ExpectExit 2 -Expect @("mailbox was not confirmed", "nothing was sent")
# 4 invalid email 3x
Run-Scenario "invalid email three times: refused" ($front + @("burst:$S", "enter", "text:bad", "enter", "text:bad2", "enter", "text:bad3", "enter")) -ExpectExit 2 -Expect @("not a valid email", "not valid after 3 tries")
# 5 invalid EIN 3x
Run-Scenario "invalid EIN three times: refused" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:123", "enter", "text:456", "enter", "text:789", "enter")) -ExpectExit 2 -Expect @("must be 9 digits")
# 6 business file with a placeholder (template): refused before seeding
$tplCopy = Join-Path $sp "unfilled-template.json"; Copy-Item -LiteralPath "$repo\scripts\tw4-validation\stage-b-business.template.json" -Destination $tplCopy -Force
Run-Scenario "business file is the unfilled template: refused" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:987654321", "enter", "text:$tplCopy", "enter")) -ExpectExit 2 -Expect @("placeholder")
Run-Scenario "business file inside the repository: refused" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:987654321", "enter", "text:$repo\scripts\tw4-validation\stage-b-business.template.json", "enter")) -ExpectExit 2 -Expect @("inside the repository")
# 7 Esc at the secret prompt
Run-Scenario "Esc cancels the secret prompt" ($front + @("esc")) -ExpectExit 2 -Expect @("Cancelled by you (Esc)")
# 8 operator answers n at the seed confirmation: nothing seeded, nothing sent
Run-Scenario "answering n at the seed confirmation cancels" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:987654321", "enter", "text:$biz", "enter", "text:n", "enter")) -ExpectExit 2 -Expect @("Cancelled by you; nothing was sent")
# 9 declining cleanup keeps the local studio (then removed by the test)
Run-Scenario "declining cleanup keeps the studio and prints how to clean up" ($front + @("burst:$S", "enter", "text:compliance@example.test", "enter", "text:CONFIRMED", "enter", "text:987654321", "enter", "text:$biz", "enter", "text:y", "enter", "wait:50000", "text:n", "enter")) -ExpectExit 0 -Expect @("Local studio kept", "To clean up the LOCAL fixtures later") -ReportOnly -ExpectStudioKept
$results
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Get-ChildItem $env:TEMP -Filter "tw4-stage-b-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
