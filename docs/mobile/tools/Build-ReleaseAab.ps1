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
  [Parameter(Mandatory)][string]$Commit,
  [Parameter(Mandatory)][string]$EnvFile,
  [Parameter(Mandatory)][string]$ExpectedFile,
  [string]$GoogleServices = "",   # Student only: path of the Firebase google-services.json (never copied into the repo)
  [string]$RepoRoot = "C:\Dev\studioapp",
  [string]$Jdk = "C:\Android\jdk-17",
  [string]$Sdk = "C:\Android\sdk"
)
$ErrorActionPreference = "Stop"

# --- 1. preconditions
if (Get-Process -Name java -ErrorAction SilentlyContinue) { throw "A java/Gradle process is running. One Gradle build at a time: wait for it." }
foreach ($n in "DANCEFLOW_UPLOAD_STORE_FILE", "DANCEFLOW_UPLOAD_STORE_PASSWORD", "DANCEFLOW_UPLOAD_KEY_ALIAS", "DANCEFLOW_UPLOAD_KEY_PASSWORD") {
  if (-not [Environment]::GetEnvironmentVariable($n, "Process")) { throw "$n is not set in this shell. Dot-source Set-UploadSigningEnv.ps1 first." }
}
foreach ($f in $EnvFile, $ExpectedFile) { if (-not (Test-Path -LiteralPath $f)) { throw "Missing file: $f" } }
if ($Commit -notmatch "^[0-9a-f]{7,40}$") { throw "-Commit must be a hex SHA." }
if ($App -eq "student") {
  if (-not $GoogleServices -or -not (Test-Path -LiteralPath $GoogleServices)) { throw "Student needs -GoogleServices <path to google-services.json>." }
}

$short = $Commit.Substring(0, 8)
$work = "C:\dfr\rel-$App"
$out = "C:\dfr-out\release"
$tmp = "C:\dfr\tmp-rel-$App-$short"

# --- 2. clean worktree at the exact commit
if (Test-Path -LiteralPath $work) { & git -C $RepoRoot worktree remove --force $work | Out-Null; if (Test-Path -LiteralPath $work) { Remove-Item -Recurse -Force $work } }
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
  foreach ($n in "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY", "EXPO_PUBLIC_DANCEFLOW_WEB_URL") {
    if (-not (Get-Item "Env:$n" -ErrorAction SilentlyContinue)) { throw "$n is missing from $EnvFile" }
  }

  # --- 4. private TEMP, no CI, JDK 17, build
  if (Test-Path -LiteralPath $tmp) { Remove-Item -Recurse -Force $tmp }
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
  if (Test-Path -LiteralPath $stale) { Remove-Item -Recurse -Force $stale }

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
  Write-Host "Signer certificate (must equal the upload-key fingerprints):"
  & "$Jdk\bin\keytool.exe" -printcert -jarfile $aab | Select-String -Pattern "SHA1:|SHA256:" | ForEach-Object { "  " + $_.Line.Trim() }
  Write-Host ""
  & node (Join-Path $PSScriptRoot "verify-baked-config.js") $aab $ExpectedFile
  $verify = $LASTEXITCODE
  Write-Host ""
  if ($verify -eq 0) { Write-Host "BAKED CONFIG: PASS. The AAB is a candidate for manual upload (owner step)." -ForegroundColor Green }
  else { Write-Host "BAKED CONFIG: FAIL. DO NOT UPLOAD this AAB." -ForegroundColor Red; exit 1 }
} finally {
  Pop-Location
  foreach ($n in "DANCEFLOW_UPLOAD_STORE_FILE", "DANCEFLOW_UPLOAD_STORE_PASSWORD", "DANCEFLOW_UPLOAD_KEY_ALIAS", "DANCEFLOW_UPLOAD_KEY_PASSWORD") { [Environment]::SetEnvironmentVariable($n, $null, "Process") }
  Get-ChildItem Env: | Where-Object { $_.Name -like "EXPO_PUBLIC_*" } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
  Write-Host "DANCEFLOW_UPLOAD_* and EXPO_PUBLIC_* cleared from this process."
}
