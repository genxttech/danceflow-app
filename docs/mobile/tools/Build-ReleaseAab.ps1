<#
.SYNOPSIS
  Supervised build of ONE app's first Play release AAB (unminified), then the baked-config check. One command per app.

.DESCRIPTION
  Run only on the owner's go, from the shell where Set-UploadSigningEnv.ps1 was dot-sourced (the DANCEFLOW_UPLOAD_* variables
  must already be set). It:
    1. refuses to start if java/Gradle is already running (one Gradle build at a time on this shared PC) or any DANCEFLOW_UPLOAD_*
       variable is missing;
    2. makes a clean detached git worktree of the repo at EXACTLY -Commit (default: the pinned commit in
       Android_First_Internal_Release_Prep.md section 4) under C:\dfr\rel-<app>, and runs npm ci there;
    3. reads the production EXPO_PUBLIC_* values from -EnvFile (a local file OUTSIDE the repo; never printed) into this process;
       it ignores any EXPO_PUBLIC_* already in your shell so a stale value cannot leak in;
    4. uses a private empty TEMP/TMP, unsets CI, deletes createBundleReleaseJsAndAssets, builds `bundleRelease --no-daemon`
       (NO minify);
    5. copies the AAB to C:\dfr-out\release\<app>-<commit>.aab, prints size, SHA-256 and the signer certificate fingerprints
       (compare with the ones New-UploadKeystore.ps1 printed), and runs verify-baked-config.js against -ExpectedFile.
  It never uploads anything, never prints a secret, and clears the DANCEFLOW_UPLOAD_* variables when it ends.

.EXAMPLE
  . C:\Dev\studioapp\docs\mobile\tools\Set-UploadSigningEnv.ps1
  C:\Dev\studioapp\docs\mobile\tools\Build-ReleaseAab.ps1 -App student -Commit <sha> -EnvFile C:\Users\mcurt\df-credentials\release\student.env -ExpectedFile C:\Users\mcurt\df-credentials\release\expected-student.json -GoogleServices C:\Users\mcurt\df-credentials\firebase-dev\google-services.json
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet("student", "business")][string]$App,
  [string]$Commit = "",
  [string]$EnvFile = "",
  [string]$ExpectedFile = "",    # required for a build or -CheckOnly; not used by -SetupCheck
  [string]$GoogleServices = "",   # Student only: path of the Firebase google-services.json (never copied into the repo)
  # Business only: EXPO_PUBLIC_STAFF_FEATURES for this build (comma list). Empty = the app defaults (clients, attendance), unless -EnvFile carries one.
  # "pulse" / "studioSchedule" are refused unless the production smoke summary (Invoke-StaffApiSmoke.ps1) shows those routes PASS.
  [string]$StaffFeatures = "",
  [string]$SmokeSummary = "C:\dfr-out\release\checks\business-staff-smoke.txt",
  # Business write words (appointmentAttendance, clientNotes, clientCreate, classRoster): iso-qa device-smoke evidence for THIS commit (production writes are not allowed).
  [string]$WriteEvidence = "C:\dfr-out\release\checks\business-writes-isoqa-smoke.txt",
  [string]$RepoRoot = "C:\Dev\studioapp",
  [string]$Jdk = "C:\Android\jdk-17",
  [string]$Sdk = "C:\Android\sdk",
  # Dry mode: no build, no worktree, no Gradle, no keystore. Runs ONLY the signer-pin check and the baked-config check on an
  # existing -Aab, with the same fail-closed exit codes. Used to prove the path handling and to re-check an AAB read-only.
  [switch]$CheckOnly,
  [switch]$SetupCheck,   # preflight: stale-workspace cleanup + worktree create/verify/remove at -Commit; no keystore, no build
  [string]$Aab = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "Test-StaffFeatures.ps1")   # Assert-StaffFeatures (smoke-gated optional Business screens)
. (Join-Path $PSScriptRoot "Test-UploadSigner.ps1")   # Get-AabSignerFingerprints / Assert-UploadSigner (pinned upload certificate)

# --- 0. absolute paths, resolved against the CALLER's current directory BEFORE any Set-Location/Push-Location below.
# (A relative -ExpectedFile used to be re-resolved from inside the temporary worktree and the verifier then failed to find it.)
function Resolve-CallerPath([string]$p) {
  if (-not $p) { return $p }
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($p)
}
# --- 0b. Windows long-path safe directory removal. Remove-Item -Recurse fails on the deeply nested React Native / CMake .cxx
# object paths ("Filename too long" / "Could not find a part of the path"). robocopy /MIR from an EMPTY directory deletes such trees
# without MAX_PATH limits; then the (now empty) root is removed. Scoped: only a path under C:\dfr\ is ever removed this way.
function Remove-DirTree([string]$p) {
  if (-not $p -or -not (Test-Path -LiteralPath $p)) { return }
  $full = [System.IO.Path]::GetFullPath($p).TrimEnd('\')
  if ($full -notlike 'C:\dfr\*' -or $full.Length -lt 10) { throw "Remove-DirTree refuses a path outside C:\dfr\: $full" }
  $empty = Join-Path $env:TEMP ("empty-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $empty | Out-Null
  try {
    & robocopy $empty $full /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /R:1 /W:1 | Out-Null   # exit codes 0-7 = success
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed to empty $full (exit $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
    Remove-Item -LiteralPath $full -Recurse -Force
  } finally { Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue }
}
$EnvFile = Resolve-CallerPath $EnvFile
$ExpectedFile = Resolve-CallerPath $ExpectedFile
$GoogleServices = Resolve-CallerPath $GoogleServices
$Aab = Resolve-CallerPath $Aab
$SmokeSummary = Resolve-CallerPath $SmokeSummary
$WriteEvidence = Resolve-CallerPath $WriteEvidence
$RepoRoot = Resolve-CallerPath $RepoRoot
$Jdk = Resolve-CallerPath $Jdk
$Sdk = Resolve-CallerPath $Sdk
if (-not $SetupCheck) {
  if (-not $ExpectedFile) { throw "-ExpectedFile is required (the expected baked-config JSON); only -SetupCheck can omit it." }
  if (-not (Test-Path -LiteralPath $ExpectedFile)) { throw "Missing file: $ExpectedFile" }
}

if ($CheckOnly) {
  # --- dry mode: signer pin + baked config on an existing AAB; nothing is built, no keystore or password is needed
  if (-not $Aab -or -not (Test-Path -LiteralPath $Aab)) { throw "-CheckOnly needs -Aab <existing .aab>." }
  Write-Host "CHECK ONLY (no build): $Aab" -ForegroundColor Cyan
  $bad = 0
  try { Assert-UploadSigner -Aab $Aab -Keytool "$Jdk\bin\keytool.exe" }
  catch { Write-Host "SIGNER CHECK: FAIL. $($_.Exception.Message)" -ForegroundColor Red; $bad++ }
  & node (Join-Path $PSScriptRoot "verify-baked-config.js") $Aab $ExpectedFile
  if ($LASTEXITCODE -ne 0) { Write-Host "BAKED CONFIG: FAIL (verifier exit $LASTEXITCODE)." -ForegroundColor Red; $bad++ }
  if ($bad) { Write-Host "DO NOT UPLOAD $Aab" -ForegroundColor Red; exit 1 }
  Write-Host "CHECKS: PASS (signer equals the pin; baked config verified)." -ForegroundColor Green
  exit 0
}

if ($SetupCheck) {
  # --- setup preflight: proves the long-path-safe cleanup + worktree setup work. No keystore, no password, no Gradle.
  if ($Commit -notmatch "^[0-9a-f]{40}$") { throw "-SetupCheck needs the full 40-char -Commit." }
  $w = "C:\dfr\rel-$App"
  if (Test-Path -LiteralPath $w) { Write-Host "SETUP CHECK: removing existing $w" -ForegroundColor Yellow; Remove-DirTree $w }
  & git -C $RepoRoot worktree prune | Out-Null; $global:LASTEXITCODE = 0
  & git -C $RepoRoot worktree add --detach $w $Commit | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "SETUP CHECK FAIL: git worktree add failed for $Commit." }
  $h = (& git -C $w rev-parse HEAD).Trim()
  if ($h -ne $Commit) { throw "SETUP CHECK FAIL: worktree HEAD $h is not $Commit." }
  # synthetic over-MAX_PATH tree like the CMake .cxx output
  $deep = "\\?\$w\mobile\$App\android\app\.cxx\" + ((1..14 | ForEach-Object { "very-long-directory-name-segment-$_" }) -join "\")
  New-Item -ItemType Directory -Path $deep -Force | Out-Null
  Set-Content -LiteralPath "$deep\x.o" -Value "x"
  Write-Host "Synthetic deep tree length: $($deep.Length)" -ForegroundColor Cyan
  Remove-DirTree $w
  & git -C $RepoRoot worktree prune | Out-Null; $global:LASTEXITCODE = 0
  if (Test-Path -LiteralPath $w) { throw "SETUP CHECK FAIL: $w still exists after cleanup." }
  if (& git -C $RepoRoot worktree list --porcelain | Select-String -SimpleMatch ($w -replace '\\', '/')) { throw "SETUP CHECK FAIL: worktree still registered." }
  Write-Host "SETUP CHECK: PASS (deep tree removed, worktree gone and deregistered, HEAD was exactly $Commit)." -ForegroundColor Green
  exit 0
}

# --- 1. preconditions
if (Get-Process -Name java -ErrorAction SilentlyContinue) { throw "A java/Gradle process is running. One Gradle build at a time: wait for it." }
foreach ($n in "DANCEFLOW_UPLOAD_STORE_FILE", "DANCEFLOW_UPLOAD_STORE_PASSWORD", "DANCEFLOW_UPLOAD_KEY_ALIAS", "DANCEFLOW_UPLOAD_KEY_PASSWORD") {
  if (-not [Environment]::GetEnvironmentVariable($n, "Process")) { throw "$n is not set in this shell. Dot-source Set-UploadSigningEnv.ps1 first." }
}
# Gradle runs from inside the worktree, so a relative keystore path would break there: make it absolute now.
$ksPath = Resolve-CallerPath ([Environment]::GetEnvironmentVariable("DANCEFLOW_UPLOAD_STORE_FILE", "Process"))
if (-not (Test-Path -LiteralPath $ksPath)) { throw "Keystore file not found (DANCEFLOW_UPLOAD_STORE_FILE)." }
[Environment]::SetEnvironmentVariable("DANCEFLOW_UPLOAD_STORE_FILE", $ksPath, "Process")
if (-not $EnvFile -or -not (Test-Path -LiteralPath $EnvFile)) { throw "Missing file: -EnvFile $EnvFile" }
if ($Commit -notmatch "^[0-9a-f]{7,40}$") { throw "-Commit must be a hex SHA." }
# Business: the effective staff-feature list (the parameter wins over a line in the env file) is checked BEFORE anything is built.
$effectiveFeatures = ""
if ($App -eq "business") {
  $effectiveFeatures = $StaffFeatures
  if (-not $effectiveFeatures) {
    foreach ($line in Get-Content -LiteralPath $EnvFile) { if ($line -match "^\s*EXPO_PUBLIC_STAFF_FEATURES\s*=\s*(.*?)\s*$") { $effectiveFeatures = $Matches[1] } }
  }
  Assert-StaffFeatures -Features $effectiveFeatures -SummaryPath $SmokeSummary -WriteEvidencePath $WriteEvidence -Commit $Commit
  Write-Host "Staff features for this build: $(if ($effectiveFeatures) { $effectiveFeatures } else { "(defaults: clients, attendance)" })" -ForegroundColor Cyan
}
if ($App -eq "student") {
  if (-not $GoogleServices -or -not (Test-Path -LiteralPath $GoogleServices)) { throw "Student needs -GoogleServices <path to google-services.json>." }
}

$short = $Commit.Substring(0, 8)
$work = "C:\dfr\rel-$App"
$out = "C:\dfr-out\release"
$tmp = "C:\dfr\tmp-rel-$App-$short"

# --- 2. clean worktree at the exact commit
# Do NOT call `git worktree remove` on a stale tree: git cannot delete the deep .cxx paths ("Filename too long") and, under
# $ErrorActionPreference=Stop in Windows PowerShell 5.1, a native stderr line becomes a terminating NativeCommandError even with 2>$null.
# Instead: delete the directory with the long-path-safe method, prune the (now dangling) registration, then VERIFY both are gone.
if (Test-Path -LiteralPath $work) { Write-Host "Removing stale workspace $work ..." -ForegroundColor Yellow; Remove-DirTree $work }
& git -C $RepoRoot worktree prune | Out-Null; $global:LASTEXITCODE = 0
if (Test-Path -LiteralPath $work) { throw "CLEANUP FAILED: $work still exists after long-path-safe removal. Close anything using it (Explorer, an editor, a stray java/node process) and retry." }
$registered = (& git -C $RepoRoot worktree list --porcelain | Select-String -SimpleMatch ($work -replace '\\', '/'))
if ($registered) { throw "CLEANUP FAILED: git still lists $work as a worktree after prune." }
$global:LASTEXITCODE = 0
& git -C $RepoRoot worktree add --detach $work $Commit | Out-Null
if ($LASTEXITCODE -ne 0) { throw "git worktree add failed for $Commit (fetch first?)." }
$head = (& git -C $work rev-parse HEAD).Trim()
Write-Host "Building $App from $head in $work" -ForegroundColor Cyan
$appDir = Join-Path $work "mobile\$App"

Push-Location $appDir
try {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

  # --- 3. production EXPO_PUBLIC_* from the local env file only
  Get-ChildItem Env: | Where-Object { $_.Name -like "EXPO_PUBLIC_*" } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match "^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=\s*(.*?)\s*$") { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] }
  }
  if ($App -eq "business") {
    Remove-Item Env:EXPO_PUBLIC_STAFF_FEATURES -ErrorAction SilentlyContinue
    if ($effectiveFeatures) { $env:EXPO_PUBLIC_STAFF_FEATURES = $effectiveFeatures }
  }
  foreach ($n in "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY", "EXPO_PUBLIC_DANCEFLOW_WEB_URL") {
    if (-not (Get-Item "Env:$n" -ErrorAction SilentlyContinue)) { throw "$n is missing from $EnvFile" }
  }

  # --- 4. private TEMP, no CI, JDK 17, build
  if (Test-Path -LiteralPath $tmp) { Remove-DirTree $tmp }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $env:TEMP = $tmp; $env:TMP = $tmp
  Remove-Item Env:CI -ErrorAction SilentlyContinue
  $env:JAVA_HOME = $Jdk; $env:ANDROID_HOME = $Sdk
  $env:PATH = "$Jdk\bin;$env:PATH"
  $env:NODE_ENV = "production"

  if ($App -eq "student") {
    & node scripts\google-services-check.js --copy $GoogleServices android\app\google-services.json com.idanceflow.student
    if ($LASTEXITCODE -ne 0) { throw "google-services.json check/copy failed" }
    $android = Join-Path $appDir "android"
  } else {
    & npx expo prebuild --platform android --clean --no-install
    if ($LASTEXITCODE -ne 0) { throw "expo prebuild failed" }
    $android = Join-Path $appDir "android"
    Set-Content -LiteralPath (Join-Path $android "local.properties") -Value ("sdk.dir=" + ($Sdk -replace "\\", "/"))
  }
  $stale = Join-Path $android "app\build\generated\assets\createBundleReleaseJsAndAssets"
  if (Test-Path -LiteralPath $stale) { Remove-DirTree $stale }

  Push-Location $android
  try {
    & .\gradlew.bat bundleRelease --no-daemon "-Dorg.gradle.jvmargs=-Xmx3g -XX:MaxMetaspaceSize=768m"
    if ($LASTEXITCODE -ne 0) { throw "Gradle bundleRelease failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }

  # --- 5. collect, fingerprint, verify
  New-Item -ItemType Directory -Force -Path $out | Out-Null
  $aab = Join-Path $out "$App-$short.aab"
  Copy-Item -LiteralPath (Join-Path $android "app\build\outputs\bundle\release\app-release.aab") -Destination $aab -Force
  $item = Get-Item -LiteralPath $aab
  Write-Host ""
  Write-Host "AAB:    $aab" -ForegroundColor Green
  Write-Host "Size:   $($item.Length) bytes"
  Write-Host "SHA-256 (file): $((Get-FileHash -Algorithm SHA256 -LiteralPath $aab).Hash)"
  Write-Host "Signer certificate (must equal the pinned upload certificate in upload-cert.json; the QA key is always rejected):"
  try { Assert-UploadSigner -Aab $aab -Keytool "$Jdk\bin\keytool.exe" }
  catch {
    Write-Host "SIGNER CHECK: FAIL. $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "DO NOT UPLOAD $aab" -ForegroundColor Red
    exit 1
  }
  Write-Host ""
  & node (Join-Path $PSScriptRoot "verify-baked-config.js") $aab $ExpectedFile
  $verify = $LASTEXITCODE
  Write-Host ""
  if ($verify -eq 0) { Write-Host "BAKED CONFIG: PASS. The AAB is a candidate for manual upload (owner step)." -ForegroundColor Green }
  else { Write-Host "BAKED CONFIG: FAIL (verifier exit $verify). DO NOT UPLOAD $aab" -ForegroundColor Red; exit 1 }
} finally {
  Pop-Location
  foreach ($n in "DANCEFLOW_UPLOAD_STORE_FILE", "DANCEFLOW_UPLOAD_STORE_PASSWORD", "DANCEFLOW_UPLOAD_KEY_ALIAS", "DANCEFLOW_UPLOAD_KEY_PASSWORD") { [Environment]::SetEnvironmentVariable($n, $null, "Process") }
  Get-ChildItem Env: | Where-Object { $_.Name -like "EXPO_PUBLIC_*" } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  Write-Host "DANCEFLOW_UPLOAD_* and EXPO_PUBLIC_* cleared from this process."
}
exit 0
