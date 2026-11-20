<#
.SYNOPSIS
  Gate for the Business build's EXPO_PUBLIC_STAFF_FEATURES. Dot-sourced by Build-ReleaseAab.ps1.

.DESCRIPTION
  Assert-StaffFeatures -Features "<comma list>" -SummaryPath <business-staff-smoke.txt> [-WriteEvidencePath <business-writes-isoqa-smoke.txt> -Commit <sha>]

  READ screens: "pulse" and "studioSchedule" are allowed only when the PRODUCTION read-only smoke (Invoke-StaffApiSmoke.ps1) shows that route PASS:
    - "RESULT: PASS", "host=www.idanceflow.com" (a loopback self-test run does not count), at most -MaxAgeHours old,
    - "PASS  GET /workspaces/:studioId/pulse  200" for pulse, the same for /schedule for studioSchedule.

  WRITE words (Phase 1A): appointmentAttendance, clientNotes, clientCreate, classRoster. Production writes are forbidden (owner decision D3), so a write word is allowed only
  when there is iso-qa DEVICE-smoke evidence for the exact commit being built. The evidence file is written by the device smoke (disposable stack, never production):

      Business Phase 1A write smoke (iso-qa device smoke, disposable stack; never production)
      Date: 2026-11-20T18:00:00.000Z
      kind=iso-qa-device-smoke  stack=iso-qa  commit=<full 40-hex sha>
      CAPABILITY clientNotes PASS
      CAPABILITY classRoster PASS
      RESULT: PASS

    Required for each write word named: a "CAPABILITY <word> PASS" line; for the file: "RESULT: PASS", "kind=iso-qa-device-smoke", "stack=iso-qa", a commit equal to (or a
    prefix-match of, at least 7 characters) the -Commit being built, a Date within -MaxAgeHours, and NO "host=www.idanceflow.com" (evidence from production is refused).
    Having the word in the build is not enough to make writes work: the server policy STAFF_API_WRITE_POLICY must also enable the capability (fail closed).

  Other rules: empty list = the app defaults (clients, attendance), no evidence needed. Allowed words: clients, attendance, pulse, studioSchedule, the four write words,
  -clients, -attendance, none. bulkAttendance, keepStale and unknown words are refused (not walked on a device / not features).

  Self-test:  powershell -File Test-StaffFeatures.ps1 -SelfTest
#>
[CmdletBinding()]
param([switch]$SelfTest)

$script:WriteWords = "appointmentAttendance", "clientNotes", "clientCreate", "classRoster"

function Get-EvidenceDate([string]$text, [string]$what) {
  if ($text -notmatch "(?m)^Date: (\S+)") { throw "Refusing: the $what has no Date line." }
  return [datetime]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
}

function Assert-StaffFeatures {
  param([string]$Features, [string]$SummaryPath, [string]$WriteEvidencePath = "", [string]$Commit = "", [int]$MaxAgeHours = 72)
  $words = @(($Features -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $allowed = @("clients", "attendance", "pulse", "studioSchedule", "-clients", "-attendance", "none") + $script:WriteWords
  foreach ($w in $words) {
    if ($allowed -notcontains $w) { throw "EXPO_PUBLIC_STAFF_FEATURES word '$w' is not allowed for a release build (allowed: $($allowed -join ', '); bulkAttendance and keepStale have not been walked on a device)." }
  }

  # ---- read screens: production read-only smoke
  $needPulse = $words -contains "pulse"
  $needSched = $words -contains "studioSchedule"
  if ($needPulse -or $needSched) {
    if (-not $SummaryPath -or -not (Test-Path -LiteralPath $SummaryPath)) { throw "Refusing: '$Features' needs the production smoke summary ($SummaryPath). Run Invoke-StaffApiSmoke.ps1 first." }
    $text = Get-Content -LiteralPath $SummaryPath -Raw
    if ($text -notmatch "(?m)^RESULT: PASS\b") { throw "Refusing: the smoke summary does not say RESULT: PASS." }
    if ($text -notmatch "host=www\.idanceflow\.com\b") { throw "Refusing: the smoke summary is not a production run (host is not www.idanceflow.com)." }
    $when = Get-EvidenceDate $text "smoke summary"
    if (((Get-Date).ToUniversalTime() - $when.ToUniversalTime()).TotalHours -gt $MaxAgeHours) { throw "Refusing: the smoke summary is older than $MaxAgeHours hours. Run Invoke-StaffApiSmoke.ps1 again." }
    if ($needPulse -and $text -notmatch "(?m)^PASS\s+GET /workspaces/:studioId/pulse\s+200") { throw "Refusing 'pulse': the smoke did not PASS /pulse." }
    if ($needSched -and $text -notmatch "(?m)^PASS\s+GET /workspaces/:studioId/schedule\s+200") { throw "Refusing 'studioSchedule': the smoke did not PASS /schedule (a 403 for an instructor is not a pass)." }
  }

  # ---- write words: iso-qa device-smoke evidence for this exact commit (no production writes)
  $writeNamed = @($words | Where-Object { $script:WriteWords -contains $_ })
  if ($writeNamed.Count -gt 0) {
    if (-not $WriteEvidencePath -or -not (Test-Path -LiteralPath $WriteEvidencePath)) { throw "Refusing '$($writeNamed -join ',')': write features need iso-qa device-smoke evidence ($WriteEvidencePath). Production writes are not allowed (D3)." }
    if ($Commit -notmatch "^[0-9a-f]{7,40}$") { throw "Refusing '$($writeNamed -join ',')': the build commit is unknown, so the evidence cannot be matched to it." }
    $ev = Get-Content -LiteralPath $WriteEvidencePath -Raw
    if ($ev -notmatch "(?m)^RESULT: PASS\b") { throw "Refusing: the write evidence does not say RESULT: PASS." }
    if ($ev -notmatch "kind=iso-qa-device-smoke\b") { throw "Refusing: the write evidence is not an iso-qa device smoke (kind=iso-qa-device-smoke)." }
    if ($ev -notmatch "stack=iso-qa\b") { throw "Refusing: the write evidence does not name the disposable stack (stack=iso-qa)." }
    if ($ev -match "host=www\.idanceflow\.com") { throw "Refusing: the write evidence mentions the production host. Writes are proven on the disposable stack only." }
    if ($ev -notmatch "commit=([0-9a-f]{7,40})\b") { throw "Refusing: the write evidence has no commit." }
    $evCommit = $Matches[1]
    if (-not ($Commit.StartsWith($evCommit) -or $evCommit.StartsWith($Commit))) { throw "Refusing: the write evidence is for commit $evCommit, not the commit being built ($Commit)." }
    $whenW = Get-EvidenceDate $ev "write evidence"
    if (((Get-Date).ToUniversalTime() - $whenW.ToUniversalTime()).TotalHours -gt $MaxAgeHours) { throw "Refusing: the write evidence is older than $MaxAgeHours hours." }
    foreach ($w in $writeNamed) {
      if ($ev -notmatch "(?m)^CAPABILITY $w PASS\b") { throw "Refusing '$w': the write evidence has no 'CAPABILITY $w PASS' line." }
    }
  }
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

  # ---- write evidence
  $sha = "0123456789abcdef0123456789abcdef01234567"
  function Evidence($path, $date, $extra, $result, $caps, $kind = "iso-qa-device-smoke", $stack = "iso-qa", $commit = $sha) {
    $lines = @("Business Phase 1A write smoke (iso-qa device smoke, disposable stack; never production)", "Date: $date", "kind=$kind  stack=$stack  commit=$commit  $extra")
    foreach ($c in $caps) { $lines += "CAPABILITY $c PASS" }
    $lines += "RESULT: $result"
    $lines | Set-Content -LiteralPath $path
  }
  $wGood = Join-Path $dir "w-good.txt";  Evidence $wGood $now "" "PASS" @("clientNotes", "classRoster")
  $wOld = Join-Path $dir "w-old.txt";    Evidence $wOld $old "" "PASS" @("clientNotes")
  $wFail = Join-Path $dir "w-fail.txt";  Evidence $wFail $now "" "FAIL" @("clientNotes")
  $wProd = Join-Path $dir "w-prod.txt";  Evidence $wProd $now "host=www.idanceflow.com" "PASS" @("clientNotes")
  $wKind = Join-Path $dir "w-kind.txt";  Evidence $wKind $now "" "PASS" @("clientNotes") "emulator-poke"
  $wStack = Join-Path $dir "w-stack.txt"; Evidence $wStack $now "" "PASS" @("clientNotes") "iso-qa-device-smoke" "dev"
  $wOther = Join-Path $dir "w-other.txt"; Evidence $wOther $now "" "PASS" @("clientNotes") "iso-qa-device-smoke" "iso-qa" "fedcba9876543210fedcba9876543210fedcba98"
  Check "write word needs evidence (missing file refused)"        (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $missing -Commit $sha })
  Check "write words pass with matching iso-qa evidence"          (-not (Throws { Assert-StaffFeatures -Features "clientNotes,classRoster" -SummaryPath $missing -WriteEvidencePath $wGood -Commit $sha }))
  Check "a short commit prefix matches"                           (-not (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wGood -Commit $sha.Substring(0, 9) }))
  Check "a word without its CAPABILITY line is refused"           (Throws { Assert-StaffFeatures -Features "clientCreate" -SummaryPath $missing -WriteEvidencePath $wGood -Commit $sha })
  Check "evidence for another commit is refused"                  (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wOther -Commit $sha })
  Check "unknown build commit is refused"                         (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wGood -Commit "" })
  Check "stale write evidence refused"                            (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wOld -Commit $sha })
  Check "RESULT: FAIL write evidence refused"                     (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wFail -Commit $sha })
  Check "evidence mentioning the production host refused (D3)"    (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wProd -Commit $sha })
  Check "evidence that is not an iso-qa device smoke refused"     (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wKind -Commit $sha })
  Check "evidence without the iso-qa stack refused"               (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $missing -WriteEvidencePath $wStack -Commit $sha })
  Check "a production read summary is NOT write evidence"         (Throws { Assert-StaffFeatures -Features "clientNotes" -SummaryPath $good -WriteEvidencePath $good -Commit $sha })
  Check "reads and writes together need both proofs"              (-not (Throws { Assert-StaffFeatures -Features "pulse,clientNotes" -SummaryPath $good -WriteEvidencePath $wGood -Commit $sha }))
  Check "reads and writes together: missing read proof refused"   (Throws { Assert-StaffFeatures -Features "pulse,clientNotes" -SummaryPath $missing -WriteEvidencePath $wGood -Commit $sha })
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  if ($ok) { Write-Host "ALL OK"; exit 0 } else { Write-Host "FAILED"; exit 1 }
}
