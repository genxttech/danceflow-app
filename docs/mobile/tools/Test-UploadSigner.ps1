<#
.SYNOPSIS
  Dot-source for Get-AabSignerFingerprints and Assert-UploadSigner (used by Build-ReleaseAab.ps1; no password involved).

.DESCRIPTION
  `keytool -printcert -jarfile <aab>` prints the signer certificate of a signed AAB/APK/JAR without any password, so its output
  may be piped. Assert-UploadSigner fails unless the signer SHA-256 equals the pinned upload certificate in upload-cert.json and
  always rejects the QA-only key.

  Self-check (no real key needed):  . .\Test-UploadSigner.ps1 ; Test-UploadSignerSelfCheck -QaAab C:\dfr-out\rc5\student-rc5.aab
#>

# Directory of this file, captured when it is dot-sourced ($PSScriptRoot is unreliable inside param() defaults on PowerShell 5.1).
$script:UploadSignerDir = $PSScriptRoot

function ConvertTo-Fingerprint([string]$s) { ($s.Trim().ToUpperInvariant() -replace "[^0-9A-F]", "") }

function Get-AabSignerFingerprints {
  param([Parameter(Mandatory)][string]$Aab, [string]$Keytool = "C:\Android\jdk-17\bin\keytool.exe")
  $lines = & $Keytool -printcert -jarfile $Aab 2>&1
  if ($LASTEXITCODE -ne 0) { throw "keytool -printcert failed for $Aab (is it signed?): $($lines -join ' ')" }
  $sha1 = $null; $sha256 = $null
  foreach ($l in $lines) {
    if ($l -match "^\s*SHA1:\s*(.+)$") { if (-not $sha1) { $sha1 = $Matches[1].Trim() } }
    if ($l -match "^\s*SHA256:\s*(.+)$") { if (-not $sha256) { $sha256 = $Matches[1].Trim() } }
  }
  if (-not $sha256) { throw "No signer certificate found in $Aab (unsigned bundle?)." }
  [pscustomobject]@{ Sha1 = $sha1; Sha256 = $sha256 }
}

function Assert-UploadSigner {
  param(
    [Parameter(Mandatory)][string]$Aab,
    [string]$PinFile = "",
    [string]$Keytool = "C:\Android\jdk-17\bin\keytool.exe"
  )
  if (-not $PinFile) { $PinFile = Join-Path $script:UploadSignerDir "upload-cert.json" }
  $pin =Get-Content -LiteralPath $PinFile -Raw | ConvertFrom-Json
  $got = Get-AabSignerFingerprints -Aab $Aab -Keytool $Keytool
  Write-Host "  AAB signer SHA-256: $($got.Sha256)"
  Write-Host "  AAB signer SHA-1:   $($got.Sha1)"
  if ((ConvertTo-Fingerprint $got.Sha256) -eq (ConvertTo-Fingerprint $pin.rejectedQaSha256)) {
    throw "The AAB is signed with the QA-ONLY key. Never upload it. Build with the upload keystore (Set-UploadSigningEnv.ps1)."
  }
  if ((ConvertTo-Fingerprint $got.Sha256) -ne (ConvertTo-Fingerprint $pin.sha256)) {
    throw "Signer SHA-256 does not equal the pinned upload certificate ($($pin.sha256)). Wrong keystore or key. DO NOT UPLOAD."
  }
  Write-Host "  SIGNER: equals the pinned upload certificate." -ForegroundColor Green
}

function Test-UploadSignerSelfCheck {
  param([Parameter(Mandatory)][string]$QaAab, [string]$PinFile = "")
  if (-not $PinFile) { $PinFile = Join-Path $script:UploadSignerDir "upload-cert.json" }
  $ok = $true
  # 1. the QA-signed AAB must be rejected, naming the QA key
  try { Assert-UploadSigner -Aab $QaAab -PinFile $PinFile | Out-Null; Write-Host "BAD: QA-signed AAB was accepted"; $ok = $false }
  catch { if ($_.Exception.Message -match "QA-ONLY") { Write-Host "ok   QA-signed AAB rejected as the QA key" } else { Write-Host "BAD: wrong rejection: $($_.Exception.Message)"; $ok = $false } }
  # 2. with the pin temporarily set to the QA key (and nothing rejected) the same AAB must be accepted: proves the comparison
  $got = Get-AabSignerFingerprints -Aab $QaAab
  $tmp = Join-Path $env:TEMP ("pin-test-" + [guid]::NewGuid() + ".json")
  try {
    @{ sha256 = $got.Sha256; sha1 = $got.Sha1; rejectedQaSha256 = "00:00" } | ConvertTo-Json | Set-Content -LiteralPath $tmp
    try { Assert-UploadSigner -Aab $QaAab -PinFile $tmp | Out-Null; Write-Host "ok   matching pin accepted" } catch { Write-Host "BAD: matching pin rejected: $($_.Exception.Message)"; $ok = $false }
    @{ sha256 = "AA:BB"; sha1 = "AA"; rejectedQaSha256 = "00:00" } | ConvertTo-Json | Set-Content -LiteralPath $tmp
    try { Assert-UploadSigner -Aab $QaAab -PinFile $tmp | Out-Null; Write-Host "BAD: mismatching pin accepted"; $ok = $false } catch { Write-Host "ok   mismatching pin rejected" }
  } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  if ($ok) { Write-Host "SELF-CHECK PASS" -ForegroundColor Green } else { Write-Host "SELF-CHECK FAIL" -ForegroundColor Red }
  return $ok
}
