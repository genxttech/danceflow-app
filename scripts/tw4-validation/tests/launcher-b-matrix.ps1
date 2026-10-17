$ErrorActionPreference = "Continue"
# Portable paths: everything is relative to this file; scratch output goes to %TEMP%\tw4-launcher-tests.
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sp = Join-Path $env:TEMP "tw4-launcher-tests"; New-Item -ItemType Directory -Force $sp | Out-Null
$hereFwd = $here -replace '\\', '/'
$spFwd = $sp -replace '\\', '/'
$reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
$log = "$spFwd/netblock.log"; Remove-Item $log -ErrorAction SilentlyContinue
$env:NETBLOCK_LOG = $log; $env:NODE_OPTIONS = "--require $hereFwd/netblock.cjs"
$S = "selftestselftestselftestselftest"   # the dry-run synthetic secret: must never appear anywhere
$results = New-Object System.Collections.Generic.List[string]
$tmp = Join-Path $env:TEMP "tw4-matrix"; New-Item -ItemType Directory -Force $tmp | Out-Null

function Db([string]$sql) { (docker exec supabase_db_danceflow-e2e-qa psql -U postgres -At -c $sql) -join "" }
function Leftover-State { "studios=" + (Db "select count(*) from public.studios where id::text like '7a1d0000-%'") + " ledger=" + (Db "select count(*) from public.studio_sms_provisioning_steps where studio_id::text like '7a1d0000-%'") }

$tpl = Get-Content "$repo\scripts\tw4-validation\stage-b-business.template.json" -Raw | ConvertFrom-Json
function Write-Business([string]$name, [scriptblock]$mutate) {
  $ok = [ordered]@{ legal_name = "Matrix LLC"; entity_type = "llc"; industry = "EDUCATION"; website_choice = "danceflow"; website_url = ""; address_line1 = "1 Way"; address_line2 = ""; city = "Portland"; region = "OR"; postal_code = "97201"; rep_first_name = "A"; rep_last_name = "B"; rep_title = "Owner"; rep_position = "ceo"; rep_email = "a@example.test"; rep_phone = "(503) 555-0100"; preferred_area_code = "503" }
  & $mutate $ok
  $path = Join-Path $tmp "$name.json"; ($ok | ConvertTo-Json) | Set-Content -LiteralPath $path -Encoding ascii; return $path
}

function Case([string]$Name, [hashtable]$Seam, [string]$LauncherArgs, [int]$ExpectExit, [string[]]$Expect, [switch]$ExpectReports, [switch]$AllowLeftover) {
  $before = @(Get-ChildItem $reportDir -Filter "selftest-stage-b*" -ErrorAction SilentlyContinue | ForEach-Object Name)
  $beforeKeys = @(Get-ChildItem $env:TEMP -Filter "tw4-stage-b-*" -ErrorAction SilentlyContinue | ForEach-Object Name)
  foreach ($k in $Seam.Keys) { [Environment]::SetEnvironmentVariable($k, $Seam[$k], "Process") }
  $out = cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\tw4-validation\run-stage-b.ps1`" $LauncherArgs < NUL 2>&1" | Out-String
  $code = $LASTEXITCODE
  foreach ($k in $Seam.Keys) { [Environment]::SetEnvironmentVariable($k, $null, "Process") }
  $new = @(Get-ChildItem $reportDir -Filter "selftest-stage-b*" -ErrorAction SilentlyContinue | ForEach-Object Name | Where-Object { $before -notcontains $_ })
  $newKeys = @(Get-ChildItem $env:TEMP -Filter "tw4-stage-b-*" -ErrorAction SilentlyContinue | ForEach-Object Name | Where-Object { $beforeKeys -notcontains $_ })
  $problems = @()
  if ($code -ne $ExpectExit) { $problems += "exit $code (expected $ExpectExit)" }
  foreach ($e in $Expect) { if ($out -notlike "*$e*") { $problems += "missing: $e" } }
  if ($out -like "*$S*") { $problems += "OUTPUT CONTAINS THE SECRET" }
  if ($ExpectReports -and $new.Count -ne 2) { $problems += "expected report + evidence, got $($new.Count)" }
  if (-not $ExpectReports -and $new.Count -ne 0) { $problems += "unexpected report files: $($new -join ',')" }
  foreach ($f in $new) {
    $body = Get-Content (Join-Path $reportDir $f) -Raw
    if ($body -like "*$S*") { $problems += "REPORT CONTAINS THE SECRET ($f)" }
    if ($ExpectReports -and $f -notlike "*-evidence.json") {
      $j = $body | ConvertFrom-Json
      $r = $j.reports[0]
      if ($r.stage -ne "B" -or $r.result.detail -ne "step_limit" -or $r.result.stepsRun.Count -ne 10 -or -not $r.windowClosed) { $problems += "report is not a clean stage B ($($r.result.outcome)/$($r.result.detail)/$($r.result.stepsRun.Count))" }
      if ($r.adapterKind -ne "fake") { $problems += "adapterKind=$($r.adapterKind)" }
    }
    if ($f -like "*-evidence.json") {
      $rows = @($body | ConvertFrom-Json | ForEach-Object { $_ })
      if ($rows.Count -lt 10 -or @($rows | Where-Object { $_.step_key -in @("S11", "T1", "B1") }).Count -ne 0) { $problems += "evidence has $($rows.Count) rows or includes S11/T1/B1" }
    }
    Remove-Item (Join-Path $reportDir $f) -Force
  }
  if (-not $AllowLeftover) {
    $left = Leftover-State
    if ($left -ne "studios=0 ledger=0") { $problems += "LEFTOVER STATE: $left" }
    if ($newKeys.Count -ne 0 -or @(Get-ChildItem $env:TEMP -Filter "tw4-stage-b-*" | Where-Object { $beforeKeys -notcontains $_.Name }).Count -ne 0) { $problems += "leftover temp files: $($newKeys -join ',')" }
  }
  $status = if ($problems.Count -eq 0) { "PASS" } else { "FAIL: " + ($problems -join "; ") }
  $script:results.Add(("{0,-52} exit={1} {2}" -f $Name, $code, $status))
  if ($problems.Count -gt 0) { $script:results.Add("   ---- output ----`n$out") }
}

Case "dry run (all defaults)" @{} "-DryRun" 0 @("DRY RUN (self-test)", "Check passed: the real Stage B authorization refuses a non-interactive caller", "Stage B ended cleanly at its step limit (S10)", "Local fixtures removed", "Credentials cleared") -ExpectReports
Case "account/key SID swapped" @{ TW4_LAUNCHER_TEST_ACCOUNT = "SK" + ("1" * 32) } "-DryRun" 2 @("looks like an API key SID", "Account SID")
Case "key SID is an AC" @{ TW4_LAUNCHER_TEST_KEY_SID = "AC" + ("2" * 32) } "-DryRun" 2 @("looks like an Account SID")
Case "short secret" @{ TW4_LAUNCHER_TEST_KEY_SECRET = "short" } "-DryRun" 2 @("has 5 characters")
Case "invalid email" @{ TW4_LAUNCHER_TEST_EMAIL = "not-an-email" } "-DryRun" 2 @("not a valid email")
Case "invalid EIN" @{ TW4_LAUNCHER_TEST_EIN = "12345" } "-DryRun" 2 @("must be 9 digits")
Case "business file missing" @{ TW4_LAUNCHER_TEST_BUSINESS = "$tmp\nope.json" } "-DryRun" 2 @("does not exist", "Nothing was sent")
Case "business file with placeholders" @{ TW4_LAUNCHER_TEST_BUSINESS = "$repo\scripts\tw4-validation\stage-b-business.template.json" } "-DryRun" 2 @("placeholder")
Case "business: industry TECHNOLOGY not offered" @{ TW4_LAUNCHER_TEST_BUSINESS = (Write-Business "badind" { param($o) $o.industry = "TECHNOLOGY" }) } "-DryRun" 2 @("industry must be one of")
Case "business: ISV's own legal identity refused" @{ TW4_LAUNCHER_TEST_BUSINESS = (Write-Business "isvname" { param($o) $o.legal_name = "GenX TotalTech, L.L.C." }) } "-DryRun" 2 @("ISV's own legal identity", "Nothing was sent")
Case "business: DanceFlow address as representative refused" @{ TW4_LAUNCHER_TEST_BUSINESS = (Write-Business "isvmail" { param($o) $o.rep_email = "compliance@idanceflow.com" }) } "-DryRun" 2 @("DanceFlow address", "Nothing was sent")
Case "business: unknown field" @{ TW4_LAUNCHER_TEST_BUSINESS = (Write-Business "extra" { param($o) $o.ein = "123456789" }) } "-DryRun" 2 @("Unknown field 'ein'")
Case "business: bad ZIP" @{ TW4_LAUNCHER_TEST_BUSINESS = (Write-Business "zip" { param($o) $o.postal_code = "9720" }) } "-DryRun" 2 @("postal_code")
Case "failure after seed: dry run cleans up after itself" @{ TW4_LAUNCHER_TEST_FAIL_AFTER_SEED = "1" } "-DryRun" 2 @("simulated failure after seeding")
Case "real mode, stdin closed (no seam, no prompts possible)" @{} "" 2 @("not valid after 3 tries", "TW-4 Stage B: REAL Twilio WRITES")
Case "real mode: non-loopback -LocalUrl refused" @{} "-LocalUrl https://epdrtzcydvnoidwrepqz.supabase.co" 2 @("must be a loopback address")
Case "real mode: any other DB container refused (pinned)" @{} "-DbContainer no_such_container" 2 @("must be the local QA Supabase stack")
Case "real mode: a different (even running) container name refused" @{} "-AuthContainer supabase_rest_danceflow-e2e-qa" 2 @("must be the local QA Supabase stack")
Case "real mode: -AuthMinutes out of range refused" @{} "-AuthMinutes 500" 2 @("between 1 and 120")
Case "real mode: DOCKER_HOST set (remote daemon) refused" @{ DOCKER_HOST = "tcp://10.0.0.5:2375" } "" 2 @("DOCKER_HOST is set")
Case "dry run: business path with & refused" @{ TW4_LAUNCHER_TEST_BUSINESS = "C:\temp\a&b.json" } "-DryRun" 2 @("unsafe to pass to a command shim")
Case "dry run: seed fails AFTER the marker was written: cleaned up" @{ TW4_TEST_SEED_FAIL = "1" } "-DryRun" 2 @("simulated seed failure", "seeding the local test studio failed")
Case "dry run: evidence unreadable after the stage ran: exit 1, evidence file still saved" @{ TW4_TEST_EVIDENCE_FAIL = "1" } "-DryRun" 1 @("could NOT be read", "no Twilio call was possible") -ExpectReports
Case "real mode: -Interactive without -DryRun refused" @{} "-Interactive" 2 @("REFUSED (exit code 2): -Interactive is only meaningful")

Remove-Item Env:NODE_OPTIONS, Env:NETBLOCK_LOG
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
$results
"tripwire BLOCKED attempts across the whole matrix: " + @(Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -like "BLOCKED*" }).Count
