<#
.SYNOPSIS
  Run by the STANDARD agent user (never elevated) after the administrator setup. NOT RUN by engineering. Proves, by attempting each forbidden action, that this
  account CANNOT write the install root, read cred\, elevate silently, read the owner's profile or the runner's anchor/trust files. Prints a PASS/FAIL table.

.DESCRIPTION
  Every negative test is non-destructive in the success case it must not reach: the "write" tests create a uniquely named empty probe file and delete it again if
  (unexpectedly) it was created, reporting FAIL. Nothing is modified when the system is correct. No Stripe call, no network, no credential read: the "read cred\" test
  only lists the directory and tries to open a file for reading, and only reports whether Windows refused.

  Exit codes: 0 = every check ran and passed; 1 = at least one FAIL; 3 = no FAIL but at least one check could not be evaluated (SKIP): NOT fully verified.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OwnerUser,
  [string]$InstallRoot = 'C:\ProgramData\d24-runner',
  [string]$OwnerProfileRoot = 'C:\Users'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Rows = New-Object System.Collections.Generic.List[object]
function Row([string]$Id, [string]$Status, [string]$Detail) { $script:Rows.Add([pscustomobject]@{ Id = $Id; Status = $Status; Detail = $Detail }); $c = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$Status]; Write-Host ("{0,-5} {1,-34} {2}" -f $Status, $Id, $Detail) -ForegroundColor $c }

# a probe that must be REFUSED. Returns $true when Windows refused (or the target does not exist for SKIP handling by the caller).
function Test-WriteRefused([string]$dir) {
  $probe = Join-Path $dir (".d24probe-" + [guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($probe, 'x')
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue   # it should never have been created; clean up and report FAIL
    return $false
  } catch [UnauthorizedAccessException] { return $true }
  catch [System.Security.SecurityException] { return $true }
  catch { return $true }   # any other failure to create the file also means the probe did not land; the detail is printed by the caller via $_ if needed
}
function Test-ReadRefused([string]$path) {
  try { $null = Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop; return $false } catch [UnauthorizedAccessException] { return $true } catch { return ($_.Exception.Message -match 'denied|Access') }
}

# ---------------------------------------------------------------- identity and token
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$prin = New-Object Security.Principal.WindowsPrincipal($id)
Row 'not-administrator-member' $(if ($prin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'FAIL' } else { 'PASS' }) 'IsInRole(Administrator) must be false'
$sids = @($id.Groups | ForEach-Object { $_.Value })
Row 'no-administrators-sid-at-all' $(if ($sids -contains 'S-1-5-32-544') { 'FAIL' } else { 'PASS' }) 'S-1-5-32-544 must not appear in the token even as deny-only (a deny-only SID means a split administrator token)'
$integrity = (& "$env:SystemRoot\System32\whoami.exe" /groups) -join "`n"
Row 'integrity-not-high' $(if ($integrity -match 'High Mandatory Level|System Mandatory Level') { 'FAIL' } else { 'PASS' }) 'must run at Medium integrity or lower'
$priv = (& "$env:SystemRoot\System32\whoami.exe" /priv) -join "`n"
$dangerous = @('SeDebugPrivilege', 'SeTakeOwnershipPrivilege', 'SeLoadDriverPrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege', 'SeImpersonatePrivilege', 'SeTcbPrivilege') | Where-Object { $priv -match $_ }
Row 'no-dangerous-privileges' $(if ($dangerous) { 'FAIL' } else { 'PASS' }) $(if ($dangerous) { "present: $($dangerous -join ', ')" } else { 'none of Debug/TakeOwnership/LoadDriver/Backup/Restore/Impersonate/Tcb' })

# ---------------------------------------------------------------- UAC policy (HKLM is readable by standard users)
$pol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
function Get-Pol([string]$n) { (Get-ItemProperty -LiteralPath $pol -Name $n -ErrorAction SilentlyContinue).$n }
$lua = Get-Pol 'EnableLUA'; $cpu = Get-Pol 'ConsentPromptBehaviorUser'; $sd = Get-Pol 'PromptOnSecureDesktop'; $cpa = Get-Pol 'ConsentPromptBehaviorAdmin'
Row 'uac-enabled' $(if ($lua -eq 1) { 'PASS' } else { 'FAIL' }) "EnableLUA=$lua (required 1)"
Row 'uac-user-needs-credentials' $(if ($cpu -eq 1 -or $cpu -eq 0) { 'PASS' } else { 'FAIL' }) "ConsentPromptBehaviorUser=$cpu (required 1 = credentials on the secure desktop, or 0 = automatically deny; 3 prompts for credentials off the secure desktop and is NOT acceptable)"
Row 'uac-secure-desktop' $(if ($sd -eq 1) { 'PASS' } else { 'FAIL' }) "PromptOnSecureDesktop=$sd (required 1)"
Row 'uac-admin-consent' $(if ($cpa -eq 2 -or $cpa -eq 1) { 'PASS' } else { 'FAIL' }) "ConsentPromptBehaviorAdmin=$cpa (required 2 or 1; 0 and 5 allow silent or low-friction elevation for administrators)"

# ---------------------------------------------------------------- the install root
if (-not (Test-Path -LiteralPath $InstallRoot)) {
  foreach ($n in 'write-root', 'write-release', 'write-state', 'write-anchor-policy', 'read-cred', 'open-cred-file', 'inbox-no-modify') { Row $n 'SKIP' "install root $InstallRoot does not exist yet: run again after the elevated install" }
} else {
  foreach ($sub in @('', 'release', 'state', 'evidence')) {
    $d = if ($sub) { Join-Path $InstallRoot $sub } else { $InstallRoot }
    $name = if ($sub) { "write-$sub" } else { 'write-root' }
    if (-not (Test-Path -LiteralPath $d)) { Row $name 'SKIP' "$d missing"; continue }
    Row $name $(if (Test-WriteRefused $d) { 'PASS' } else { 'FAIL' }) "a standard user must NOT be able to create a file in $d"
  }
  # replacing the pinned files: opening them for WRITE must be refused (open only, nothing is written)
  $pinned = @('anchor.json', 'policy.json', 'release.json') | ForEach-Object { Join-Path $InstallRoot $_ }
  $openOk = @()
  foreach ($f in $pinned) { if (Test-Path -LiteralPath $f) { try { $fs = [IO.File]::Open($f, 'Open', 'Write', 'ReadWrite'); $fs.Close(); $openOk += $f } catch { } } }
  Row 'write-anchor-policy' $(if ($openOk.Count -gt 0) { 'FAIL' } else { 'PASS' }) $(if ($openOk.Count -gt 0) { "opened for write: $($openOk -join ', ')" } else { 'anchor.json, policy.json, release.json cannot be opened for writing' })
  $cred = Join-Path $InstallRoot 'cred'
  if (Test-Path -LiteralPath $cred) {
    Row 'read-cred' $(if (Test-ReadRefused $cred) { 'PASS' } else { 'FAIL' }) 'listing cred\ must be refused'
    $credFiles = $null
    try { $credFiles = @(Get-ChildItem -LiteralPath $cred -Force -ErrorAction Stop) } catch { }
    if ($credFiles -and $credFiles.Count -gt 0) {
      $opened = $false
      try { $s = [IO.File]::Open($credFiles[0].FullName, 'Open', 'Read', 'ReadWrite'); $s.Close(); $opened = $true } catch { }
      Row 'open-cred-file' $(if ($opened) { 'FAIL' } else { 'PASS' }) 'opening a cred\ file for reading must be refused'
    } else { Row 'open-cred-file' 'PASS' 'cred\ could not be listed, so no file is reachable' }
  } else { Row 'read-cred' 'SKIP' 'cred\ missing'; Row 'open-cred-file' 'SKIP' 'cred\ missing' }
  # the inbox: this account may NOT be the owner of the inbox; if it can create there it must not be able to modify an existing file it does not own
  $inbox = Join-Path $InstallRoot 'inbox'
  Row 'inbox-no-modify' 'SKIP' 'the inbox belongs to the OWNER account by design; run the inbox check as the owner, not as the agent (see docs section 14.4)'
}

# ---------------------------------------------------------------- the owner's data and the runner's owner-side files
$ownerPath = Join-Path $OwnerProfileRoot $OwnerUser
if (Test-Path -LiteralPath $ownerPath) {
  Row 'read-owner-profile' $(if (Test-ReadRefused $ownerPath) { 'PASS' } else { 'FAIL' }) "listing $ownerPath must be refused"
  foreach ($sub in 'AppData\Local\DanceFlow\d24-owner', 'AppData\Local\DanceFlow\d24-runner', 'AppData\Roaming', '.ssh', '.config\gh') {
    $p = Join-Path $ownerPath $sub
    Row ("read-owner-" + ($sub -replace '[\\.]', '-')) $(if ((Test-ReadRefused $p) -or -not (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) { 'PASS' } else { 'FAIL' }) "$p must not be readable"
  }
} else { Row 'read-owner-profile' 'SKIP' "$ownerPath not found (owner account name wrong or a different profile root)" }
$ownerRepo = 'C:\Dev\studioapp'
if (Test-Path -LiteralPath $ownerRepo) { Row 'read-owner-repository' $(if (Test-ReadRefused $ownerRepo) { 'PASS' } else { 'FAIL' }) "$ownerRepo (the owner's checkout with .env files) must not be readable by the agent" } else { Row 'read-owner-repository' 'SKIP' "$ownerRepo not present" }

# ---------------------------------------------------------------- credential stores reachable from THIS account
$cm = (& "$env:SystemRoot\System32\cmdkey.exe" /list) -join "`n"
Row 'no-d24-credential-in-this-profile' $(if ($cm -match 'D24-TEST|DanceFlow/D24') { 'FAIL' } else { 'PASS' }) 'Credential Manager of this account must hold no D24 TEST credential'
$envBad = @('NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY') | Where-Object { [Environment]::GetEnvironmentVariable($_) }
Row 'no-sensitive-env' $(if ($envBad) { 'FAIL' } else { 'PASS' }) $(if ($envBad) { "set in this session: $($envBad -join ', ')" } else { 'no NODE_OPTIONS/CA/Stripe variables set' })

# ---------------------------------------------------------------- what this script cannot prove
Write-Host ''
Write-Host 'NOT TESTABLE FROM HERE (owner/administrator checks, docs section 14.4): that a UAC consent for THIS account really asks for administrator CREDENTIALS on the secure desktop;'
Write-Host 'that d24run cannot log on interactively; that the scheduled task cannot be edited by this account; that the inbox owner cannot modify files it does not own.'
$fail = @($script:Rows | Where-Object Status -eq 'FAIL').Count
$skip = @($script:Rows | Where-Object Status -eq 'SKIP').Count
Write-Host ("Result: {0} PASS, {1} FAIL, {2} SKIP" -f @($script:Rows | Where-Object Status -eq 'PASS').Count, $fail, $skip)
if ($fail -gt 0) { exit 1 }
if ($skip -gt 0) { Write-Host 'NOT FULLY VERIFIED (some checks were skipped).' -ForegroundColor Yellow; exit 3 }
exit 0
