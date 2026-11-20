<#
.SYNOPSIS
  Creates the ONE Play upload keystore for both DanceFlow apps. The OWNER runs this themself, in their own PowerShell window.

.DESCRIPTION
  - Uses the JDK 17 keytool that Gradle already uses on this PC (C:\Android\jdk-17\bin\keytool.exe).
  - keytool asks for the keystore password (and its confirmation) ITSELF, hidden, at its own prompts. This script never sees,
    stores, logs or echoes a password, and puts no password on any command line.
  - Creates C:\Users\mcurt\df-credentials\upload\danceflow-upload.keystore (alias "danceflow-upload", RSA 2048, 25 years) and
    REFUSES to overwrite an existing file.
  - Prints ONLY the certificate SHA-256 and SHA-1 fingerprints (public values, safe to send to engineering).
  - Restricts the folder to the current Windows user.

  One key may sign BOTH apps (com.idanceflow.student and com.idanceflow.business). Never share the keystore or its password,
  never put them in chat, a repo, a ticket or an email.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\Dev\studioapp\docs\mobile\tools\New-UploadKeystore.ps1
#>
[CmdletBinding()]
param(
  [string]$KeystoreDir = "$env:USERPROFILE\df-credentials\upload",
  [string]$KeystoreName = "danceflow-upload.keystore",
  [string]$Alias = "danceflow-upload",
  [string]$Keytool = "C:\Android\jdk-17\bin\keytool.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Keytool)) {
  throw "keytool not found at $Keytool. Install JDK 17 or pass -Keytool <path to keytool.exe> (the JDK Gradle uses: check JAVA_HOME for a Gradle build)."
}
$ks = Join-Path $KeystoreDir $KeystoreName
if (Test-Path -LiteralPath $ks) { throw "$ks already exists. Not overwriting. If this is your real upload key, leave it alone (it cannot be recreated)." }

New-Item -ItemType Directory -Force -Path $KeystoreDir | Out-Null
# Only the current user (and SYSTEM) may read the folder.
& icacls.exe $KeystoreDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

Write-Host ""
Write-Host "keytool will now ask for a keystore password (twice) and then some name fields." -ForegroundColor Cyan
Write-Host "Type the password at ITS prompt. Choose a long one and save it in your password manager BEFORE you continue." -ForegroundColor Cyan
Write-Host "Name fields: answer anything sensible (for example DanceFlow / your name); they are public in the certificate." -ForegroundColor Cyan
Write-Host ""

# -dname is not given on purpose: keytool prompts for the fields. No -storepass/-keypass: keytool prompts, hidden.
& $Keytool -genkeypair -keystore $ks -alias $Alias -keyalg RSA -keysize 2048 -validity 9125 -storetype PKCS12
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ks)) { throw "keytool did not create the keystore (exit $LASTEXITCODE). Nothing was written." }

Write-Host ""
Write-Host "Keystore created. To print the public fingerprints keytool needs the password once more (hidden)." -ForegroundColor Cyan
$cer = Join-Path $KeystoreDir "danceflow-upload-cert.cer"
try {
  & $Keytool -exportcert -keystore $ks -alias $Alias -file $cer | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not export the certificate (wrong password?)." }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cer
  $sha256 = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData)) -replace "-", ":"
  $sha1 = ($cert.Thumbprint -replace "(..)(?!$)", '$1:')
  Write-Host ""
  Write-Host "UPLOAD CERTIFICATE FINGERPRINTS (public; send these two lines to engineering):" -ForegroundColor Green
  Write-Host "  SHA-256: $sha256"
  Write-Host "  SHA-1:   $sha1"
  Write-Host "  Alias:   $Alias"
  Write-Host "  File:    $ks"
} finally {
  if (Test-Path -LiteralPath $cer) { Remove-Item -LiteralPath $cer -Force }
}

Write-Host ""
Write-Host "NOW, BEFORE ANYTHING ELSE:" -ForegroundColor Yellow
Write-Host "  1. Save the keystore PASSWORD and the alias name ($Alias) in your password manager."
Write-Host "  2. Copy $KeystoreName to a password-manager attachment AND to an offline copy (encrypted USB or similar). Two places, not one."
Write-Host "  3. Never put the file or the password in chat, a repo, an email or a ticket. Engineering never needs them, only the fingerprints above."
Write-Host "  4. If this key is lost before the first upload nothing is lost; after Play App Signing is on, Google can reset the upload key (support request)."
