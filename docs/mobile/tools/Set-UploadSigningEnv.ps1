<#
.SYNOPSIS
  Exports the four DANCEFLOW_UPLOAD_* variables into the CURRENT PowerShell process only, so one supervised
  `gradlew bundleRelease` can sign with the upload keystore. Builds nothing.

.DESCRIPTION
  DOT-SOURCE it (note the leading ". ") so the variables stay in your shell:

      . C:\Dev\studioapp\docs\mobile\tools\Set-UploadSigningEnv.ps1

  - The password(s) are typed at hidden prompts (Read-Host -AsSecureString). Nothing is written to disk, to a log or to the
    transcript, and nothing is printed.
  - The values live only in this process (Process scope): closing the window discards them. They are NOT set for the user or
    the machine.
  - The keystore is opened once (keytool -list with the password taken from the environment, output discarded) to prove the
    password and alias are right. Only OK / not OK is shown.
  - Run Clear-UploadSigningEnv when the build is done (it also runs on exit if you use the build script).

  Never run this in a shell that is recorded, shared, or attached to a session another person or tool can read.
#>
[CmdletBinding()]
param(
  [string]$KeystoreFile = "$env:USERPROFILE\df-credentials\upload\danceflow-upload.keystore",
  [string]$Alias = "danceflow-upload",
  [string]$Keytool = "C:\Android\jdk-17\bin\keytool.exe"
)

function Clear-UploadSigningEnv {
  foreach ($n in "DANCEFLOW_UPLOAD_STORE_FILE", "DANCEFLOW_UPLOAD_STORE_PASSWORD", "DANCEFLOW_UPLOAD_KEY_ALIAS", "DANCEFLOW_UPLOAD_KEY_PASSWORD") {
    [Environment]::SetEnvironmentVariable($n, $null, "Process")
  }
  Write-Host "DANCEFLOW_UPLOAD_* cleared from this process." -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $KeystoreFile)) { throw "Keystore not found: $KeystoreFile (run New-UploadKeystore.ps1 first)." }
if (-not (Test-Path -LiteralPath $Keytool)) { throw "keytool not found at $Keytool." }

function ConvertTo-Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$store = Read-Host -AsSecureString "Keystore password (hidden)"
$same = Read-Host "Is the key password the same as the keystore password? (Y/n; Y for the default PKCS12 keystore)"
if ($same -match "^[nN]") { $key = Read-Host -AsSecureString "Key password (hidden)" } else { $key = $store }

[Environment]::SetEnvironmentVariable("DANCEFLOW_UPLOAD_STORE_FILE", $KeystoreFile, "Process")
[Environment]::SetEnvironmentVariable("DANCEFLOW_UPLOAD_KEY_ALIAS", $Alias, "Process")
[Environment]::SetEnvironmentVariable("DANCEFLOW_UPLOAD_STORE_PASSWORD", (ConvertTo-Plain $store), "Process")
[Environment]::SetEnvironmentVariable("DANCEFLOW_UPLOAD_KEY_PASSWORD", (ConvertTo-Plain $key), "Process")

# Prove the password and alias without ever printing them: -storepass:env reads the password from the environment variable.
& $Keytool -list -keystore $KeystoreFile -alias $Alias -storepass:env DANCEFLOW_UPLOAD_STORE_PASSWORD *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Keystore opens and alias '$Alias' exists. DANCEFLOW_UPLOAD_* are set for THIS PowerShell process only." -ForegroundColor Green
  Write-Host "When the supervised build is finished run:  Clear-UploadSigningEnv   (or just close this window)." -ForegroundColor Yellow
} else {
  Clear-UploadSigningEnv
  throw "keytool could not open the keystore with that password/alias. Nothing is set. Try again."
}
