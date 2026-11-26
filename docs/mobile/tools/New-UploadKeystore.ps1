<#
.SYNOPSIS
  Creates (first time) or checks (every later time) the ONE Play upload keystore for both DanceFlow apps. The OWNER runs this
  themself, in their own interactive PowerShell window.

.DESCRIPTION
  - Uses the JDK 17 keytool that Gradle uses on this PC (C:\Android\jdk-17\bin\keytool.exe).
  - IDEMPOTENT. If the keystore file does not exist it is generated. If it already exists the script NEVER regenerates or
    changes it: it skips generation and only prints the certificate fingerprints (and compares them with upload-cert.json).
  - keytool asks for the keystore password ITSELF, hidden, at its own prompt. This script never sees, stores, logs or echoes a
    password and puts no password on any command line.
  - IMPORTANT (fixed bug): keytool must be run WITHOUT any output redirection or pipe. When stdout is piped, JDK 17's
    System.console() is null, so keytool cannot show its password prompt or hide the typing, and the export step failed. The
    certificate is therefore exported to a file by a plain call (keytool prints only "Certificate stored in file ..."), and the
    SHA-256/SHA-1 are computed here from that public .cer file.
  - Prints ONLY the certificate SHA-256 and SHA-1 (public values). Never the keystore, alias password or contents.

  One key may sign BOTH apps (com.idanceflow.student and com.idanceflow.business). Never share the keystore or its password.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\docs\mobile\tools\New-UploadKeystore.ps1
#>
[CmdletBinding()]
param(
  [string]$KeystoreDir = "$env:USERPROFILE\df-credentials\upload",
  [string]$KeystoreName = "danceflow-upload.keystore",
  [string]$Alias = "danceflow-upload",
  [string]$Keytool = "C:\Android\jdk-17\bin\keytool.exe",
  [string]$PinFile = ""   # default resolved below ($PSScriptRoot is empty inside param() defaults on Windows PowerShell 5.1)
)
$ErrorActionPreference = "Stop"
if (-not $PinFile) { $PinFile = Join-Path $PSScriptRoot "upload-cert.json" }

function Get-CertFingerprints([string]$CerPath) {
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CerPath
  $sha256 = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)) -replace "-", ":"
  $sha1 = [System.BitConverter]::ToString([System.Security.Cryptography.SHA1]::Create().ComputeHash($cert.RawData)) -replace "-", ":"
  [pscustomobject]@{ Sha256 = $sha256; Sha1 = $sha1 }
}

if (-not (Test-Path -LiteralPath $Keytool)) { throw "keytool not found at $Keytool (pass -Keytool <path to JDK 17 keytool.exe>)." }
$ks = Join-Path $KeystoreDir $KeystoreName

if (Test-Path -LiteralPath $ks) {
  Write-Host "Keystore already exists: $ks" -ForegroundColor Cyan
  Write-Host "NOT regenerating it. Only the public fingerprints will be printed." -ForegroundColor Cyan
} else {
  New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
  & icacls.exe $KeystoreDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
  Write-Host ""
  Write-Host "keytool will ask for a keystore password (twice) and some name fields. Type the password at ITS prompt." -ForegroundColor Cyan
  Write-Host "Choose a long one and save it in your password manager BEFORE you continue. Name fields are public in the certificate." -ForegroundColor Cyan
  # No redirection, no pipe, no -storepass/-keypass: keytool uses the console and hides the typing.
  & $Keytool -genkeypair -keystore $ks -alias $Alias -keyalg RSA -keysize 2048 -validity 9125 -storetype PKCS12
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ks)) { throw "keytool did not create the keystore (exit $LASTEXITCODE). Nothing else was done." }
  Write-Host "Keystore created." -ForegroundColor Green
}

Write-Host ""
Write-Host "keytool asks for the keystore password once more (hidden) to export the PUBLIC certificate." -ForegroundColor Cyan
$cer = Join-Path $KeystoreDir "danceflow-upload-cert.cer"
if (Test-Path -LiteralPath $cer) { Remove-Item -LiteralPath $cer -Force }
try {
  # Plain call: keytool prints only "Certificate stored in file <...>". Do NOT pipe or redirect this (see above).
  & $Keytool -exportcert -keystore $ks -alias $Alias -file $cer
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $cer)) { throw "Could not export the certificate (wrong password or alias '$Alias'?). Run the script again." }
  $fp = Get-CertFingerprints $cer
} finally {
  if (Test-Path -LiteralPath $cer) { Remove-Item -LiteralPath $cer -Force }
}

Write-Host ""
Write-Host "UPLOAD CERTIFICATE FINGERPRINTS (public):" -ForegroundColor Green
Write-Host "  SHA-256: $($fp.Sha256)"
Write-Host "  SHA-1:   $($fp.Sha1)"
Write-Host "  Alias:   $Alias"
Write-Host "  File:    $ks"

if (Test-Path -LiteralPath $PinFile) {
  $pin = Get-Content -LiteralPath $PinFile -Raw | ConvertFrom-Json
  if ($pin.sha256 -and ($pin.sha256.ToUpperInvariant() -eq $fp.Sha256.ToUpperInvariant())) {
    Write-Host "  MATCHES the pinned upload certificate in upload-cert.json." -ForegroundColor Green
  } else {
    Write-Host "  DOES NOT MATCH the pinned upload certificate ($($pin.sha256)). This is a different key: do not build or upload with it." -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Reminders:" -ForegroundColor Yellow
Write-Host "  1. Keystore PASSWORD and alias ($Alias) in your password manager."
Write-Host "  2. The .keystore file in a password-manager attachment AND an offline copy (two places)."
Write-Host "  3. Never put the file or the password in chat, a repo, an email or a ticket; engineering needs only the fingerprints."
