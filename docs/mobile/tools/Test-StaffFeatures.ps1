<#
.SYNOPSIS
  Gate for the Business build's EXPO_PUBLIC_STAFF_FEATURES: the optional Pulse and Studio-day screens may be baked into a build only
  when the production staff smoke (Invoke-StaffApiSmoke.ps1) passed those exact routes. Dot-sourced by Build-ReleaseAab.ps1.

.DESCRIPTION
  Assert-StaffFeatures -Features "<comma list>" -SummaryPath <business-staff-smoke.txt>
    - empty list = the app defaults (clients, attendance): allowed, no smoke needed.
    - allowed words: clients, attendance, pulse, studioSchedule, -clients, -attendance, none.
    - bulkAttendance, keepStale and unknown words are refused (not walked on a device / not features).
    - pulse needs a summary line "PASS  GET /workspaces/:studioId/pulse"; studioSchedule needs "PASS  GET /workspaces/:studioId/schedule".
      The summary must also say "RESULT: PASS", "host=www.idanceflow.com" (a loopback self-test run does not count), and be at most
      -MaxAgeHours old.
  Self-test:  powershell -File Test-StaffFeatures.ps1 -SelfTest
#>
[CmdletBinding()]
param([switch]$SelfTest)

function Assert-StaffFeatures {
  param([string]$Features, [string]$SummaryPath, [int]$MaxAgeHours = 72)
  $words = @(($Features -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $allowed = "clients", "attendance", "pulse", "studioSchedule", "-clients", "-attendance", "none"
  foreach ($w in $words) {
    if ($allowed -notcontains $w) { throw "EXPO_PUBLIC_STAFF_FEATURES word '$w' is not allowed for a release build (allowed: $($allowed -join ', '); bulkAttendance and keepStale have not been walked on a device)." }
  }
  $needPulse = $words -contains "pulse"
  $needSched = $words -contains "studioSchedule"
  if (-not ($needPulse -or $needSched)) { return }
  if (-not $SummaryPath -or -not (Test-Path -LiteralPath $SummaryPath)) { throw "Refusing: '$Features' needs the production smoke summary ($SummaryPath). Run Invoke-StaffApiSmoke.ps1 first." }
  $text = Get-Content -LiteralPath $SummaryPath -Raw
  if ($text -notmatch "(?m)^RESULT: PASS\b") { throw "Refusing: the smoke summary does not say RESULT: PASS." }
  if ($text -notmatch "host=www\.idanceflow\.com\b") { throw "Refusing: the smoke summary is not a production run (host is not www.idanceflow.com)." }
  if ($text -notmatch "(?m)^Date: (\S+)") { throw "Refusing: the smoke summary has no Date line." }
  $when = [datetime]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  if (((Get-Date).ToUniversalTime() - $when.ToUniversalTime()).TotalHours -gt $MaxAgeHours) { throw "Refusing: the smoke summary is older than $MaxAgeHours hours. Run Invoke-StaffApiSmoke.ps1 again." }
  if ($needPulse -and $text -notmatch "(?m)^PASS\s+GET /workspaces/:studioId/pulse\s+200") { throw "Refusing 'pulse': the smoke did not PASS /pulse." }
  if ($needSched -and $text -notmatch "(?m)^PASS\s+GET /workspaces/:studioId/schedule\s+200") { throw "Refusing 'studioSchedule': the smoke did not PASS /schedule (a 403 for an instructor is not a pass)." }
}

if ($SelfTest) {
  $ok = $true
  function Check($name, $cond) { if ($cond) { Write-Host "ok   $name" } else { Write-Host "BAD  $name"; $script:ok = $false } }
  function Throws([scriptblock]$b) { try { & $b; return $false } catch { return $true } }
  $dir = Join-Path $env:TEMP ("sf-test-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $old = (Get-Date).ToUniversalTime().AddHours(-100).ToString("o")
  function Summary($path, $date, $hostName, $result, $pulse, $sched) {
    @("Business staff API production smoke (read-only, GET only)", "Date: $date", "SMOKE  host=$hostName  auth=password  methods=GET-only",
      "PASS  GET /me  200  cache=no-store", "$pulse  GET /workspaces/:studioId/pulse  200  cache=no-store", "$sched  GET /workspaces/:studioId/schedule  200  cache=no-store",
      "RESULT: $result  pass=3 fail=0") | Set-Content -LiteralPath $path
  }
  $good = Join-Path $dir "good.txt";   Summary $good $now "www.idanceflow.com" "PASS" "PASS" "PASS"
  $nosch = Join-Path $dir "nosched.txt"; Summary $nosch $now "www.idanceflow.com" "PASS" "PASS" "EXPECT"
  $loop = Join-Path $dir "loop.txt";   Summary $loop $now "127.0.0.1" "PASS" "PASS" "PASS"
  $stale = Join-Path $dir "stale.txt"; Summary $stale $old "www.idanceflow.com" "PASS" "PASS" "PASS"
  $bad = Join-Path $dir "fail.txt";    Summary $bad $now "www.idanceflow.com" "FAIL" "PASS" "PASS"
  $missing = Join-Path $dir "missing.txt"
  Check "defaults (empty) need no smoke"                 (-not (Throws { Assert-StaffFeatures -Features "" -SummaryPath $missing }))
  Check "explicit defaults need no smoke"                (-not (Throws { Assert-StaffFeatures -Features "clients,attendance" -SummaryPath $missing }))
  Check "pulse,studioSchedule pass with a good summary"  (-not (Throws { Assert-StaffFeatures -Features "pulse,studioSchedule" -SummaryPath $good }))
  Check "pulse refused without a summary file"           (Throws { Assert-StaffFeatures -Features "pulse" -SummaryPath $missing })
  Check "studioSchedule refused when schedule only EXPECT" (Throws { Assert-StaffFeatures -Features "studioSchedule" -SummaryPath $nosch })
  Check "pulse alone still passes when schedule is EXPECT" (-not (Throws { Assert-StaffFeatures -Features "pulse" -SummaryPath $nosch }))
  Check "loopback self-test summary refused"             (Throws { Assert-StaffFeatures -Features "pulse" -SummaryPath $loop })
  Check "stale summary refused"                          (Throws { Assert-StaffFeatures -Features "pulse" -SummaryPath $stale })
  Check "RESULT: FAIL refused"                           (Throws { Assert-StaffFeatures -Features "pulse" -SummaryPath $bad })
  Check "bulkAttendance refused"                         (Throws { Assert-StaffFeatures -Features "bulkAttendance" -SummaryPath $good })
  Check "keepStale refused"                              (Throws { Assert-StaffFeatures -Features "keepStale" -SummaryPath $good })
  Check "unknown word refused"                           (Throws { Assert-StaffFeatures -Features "pulse,wat" -SummaryPath $good })
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  if ($ok) { Write-Host "ALL OK"; exit 0 } else { Write-Host "FAILED"; exit 1 }
}
