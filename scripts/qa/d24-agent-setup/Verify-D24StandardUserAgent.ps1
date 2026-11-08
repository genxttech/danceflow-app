<#
.SYNOPSIS
  Run in the STANDARD agent user's session (never elevated) after the administrator setup. NOT RUN by engineering. Tries each forbidden action and prints a PASS/FAIL table.

.DESCRIPTION
  *** SELF-ATTESTING WHEN THE AGENT RUNS IT. *** This script lives where the agent can write and runs as the agent: if the agent runs it, its output proves nothing (the agent
  could edit it, or report any result). Engineering reads agent-run output as ADVISORY only. ***Even an OWNER-started run inside the agent's logon session is NOT
  authoritative***: the agent controls that session's HKCU\Environment, Run keys and every process of that account (same-user processes can modify each other), so a clean hash
  proves which file was started, not what ran. The AUTHORITATIVE evidence is ADMINISTRATOR-SIDE: the Setup script's dry run from the fresh administrator account (group membership,
  UAC values, ACLs, C:\Dev) plus the owner's own observation (docs 14.4). This script remains useful as an advisory in-session probe.

  Probes are non-destructive in the correct configuration: "write" probes try to create ONE empty, uniquely named file or folder and delete it if (wrongly) it was created;
  pinned files are opened for writing (nothing is written). Only Windows' "access denied" counts as a PASS; any other error is reported as FAIL (the result is unknown).
  No network, no Stripe, no credential read, no file CONTENT is read from cred\.

  Exit codes: 0 every check ran and passed; 1 at least one FAIL (including unknown errors); 3 no FAIL but at least one check could not be evaluated (SKIP, e.g. install root absent).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OwnerUser,
  [string]$InstallRoot = 'C:\ProgramData\d24-runner',
  [string]$OwnerProfileRoot = 'C:\Users',
  [string]$AdminClone = ''
)
$env:PSModulePath = "$PSHOME\Modules"
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SystemDir = 'C:\Windows\System32'
$script:Rows = New-Object System.Collections.Generic.List[object]
function Row([string]$Id, [string]$Status, [string]$Detail) { $script:Rows.Add([pscustomobject]@{ Id = $Id; Status = $Status; Detail = $Detail }); $c = @{ PASS = 'Green'; FAIL = 'Red'; SKIP = 'Yellow' }[$Status]; Write-Host ("{0,-5} {1,-40} {2}" -f $Status, $Id, $Detail) -ForegroundColor $c }

$self = $MyInvocation.MyCommand.Path
if ($self) { Write-Host ("script sha256: " + [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($self))).Replace('-', '').ToLower()) }
Write-Host 'REMINDER: this output is ADVISORY only, whoever started it: it runs inside the agent''s session. Authoritative evidence is the administrator-side Setup dry run (docs 14.4).'

# 'denied' only for Windows' access-denied; 'created' when the probe landed (and is removed again); 'error:<type>' for anything else (result unknown)
function Test-Create([string]$dir, [ValidateSet('file', 'folder')][string]$kind) {
  $probe = Join-Path $dir (".d24probe-" + [guid]::NewGuid().ToString('N'))
  try {
    if ($kind -eq 'file') { [IO.File]::WriteAllText($probe, '') } else { [void][IO.Directory]::CreateDirectory($probe) }
  } catch [UnauthorizedAccessException] { return 'denied' }
  catch { return ('error:' + $_.Exception.GetType().Name) }
  if ($kind -eq 'file') { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue } else { Remove-Item -LiteralPath $probe -Force -Recurse:$false -ErrorAction SilentlyContinue }
  return 'created'
}
function Row-Create([string]$Id, [string]$dir, [string]$kind, [string]$why) {
  if (-not (Test-Path -LiteralPath $dir)) { Row $Id 'SKIP' "$dir does not exist"; return }
  $r = Test-Create $dir $kind
  switch -Wildcard ($r) { 'denied' { Row $Id 'PASS' "creating a $kind in $dir was refused ($why)" } 'created' { Row $Id 'FAIL' "a $kind WAS created in $dir (removed again): $why" } default { Row $Id 'FAIL' "unexpected result '$r' for $dir (not access-denied, so nothing is proven)" } }
}
function Test-ReadRefused([string]$path) {
  try { $null = Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop; return 'readable' } catch [UnauthorizedAccessException] { return 'denied' } catch { return ('error:' + $_.Exception.GetType().Name) }
}
function Row-ReadDenied([string]$Id, [string]$path, [string]$why) {
  if (-not (Test-Path -LiteralPath $path -ErrorAction SilentlyContinue)) {
    # a path below a denied folder reports as absent. Walk up to the first ancestor that exists: PASS only if THAT ancestor is refused
    $anc = Split-Path -Parent $path
    while ($anc -and -not (Test-Path -LiteralPath $anc -ErrorAction SilentlyContinue)) { $anc = Split-Path -Parent $anc }
    if ($anc -and (Test-ReadRefused $anc) -eq 'denied') { Row $Id 'PASS' "$path is unreachable: the nearest visible ancestor $anc refuses listing ($why)"; return }
    Row $Id 'SKIP' "$path is absent or not visible and no refusing ancestor was found: cannot tell 'denied' from 'does not exist'"; return
  }
  $r = Test-ReadRefused $path
  switch -Wildcard ($r) { 'denied' { Row $Id 'PASS' "$path : listing refused ($why)" } 'readable' { Row $Id 'FAIL' "$path IS readable: $why" } default { Row $Id 'FAIL' "unexpected result '$r' for $path" } }
}

# Win32 CreateFile on a DIRECTORY with a specific desired access (FILE_FLAG_BACKUP_SEMANTICS); returns 0 when the open SUCCEEDED (the handle is closed at once), else the Win32 error
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class D24Probe {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string f, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int TryOpen(string path, uint access) {
    IntPtr h = CreateFileW(path, access, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(h); return 0;
  }
}
"@

# ---------------------------------------------------------------- identity and token (works for a SPLIT administrator token too)
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$prin = New-Object Security.Principal.WindowsPrincipal($id)
Row 'not-administrator-member' $(if ($prin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'FAIL' } else { 'PASS' }) 'IsInRole(Administrator) must be false (necessary, NOT sufficient: a filtered administrator token also answers false)'
# whoami lists deny-only groups; WindowsIdentity.Groups and IsInRole do NOT
$grp = @(& "$SystemDir\whoami.exe" /groups /fo csv | ConvertFrom-Csv)
$privSids = @('S-1-5-32-544', 'S-1-5-114', 'S-1-5-32-551', 'S-1-5-32-548', 'S-1-5-32-549', 'S-1-5-32-550', 'S-1-5-32-552')   # Administrators, Local account and member of Administrators, Backup/Account/Server/Print Operators, Replicator
$present = @($grp | Where-Object { $privSids -contains $_.SID } | ForEach-Object { $_.SID })
$hasAdminSid = ($present.Count -gt 0)
Row 'no-administrators-sid-even-deny-only' $(if ($hasAdminSid) { 'FAIL' } else { 'PASS' }) $(if ($hasAdminSid) { "present in the token: $($present -join ', ') (S-1-5-32-544 with `"Group used for deny only`" is a split administrator token; S-1-5-114 means a local account that is an Administrators member)" } else { 'none of S-1-5-32-544, S-1-5-114, Backup/Account/Server/Print Operators, Replicator appears in `whoami /groups` with any attribute' })
$high = @($grp | Where-Object { $_.SID -match '^S-1-16-(12288|16384)$' }).Count -gt 0
Row 'integrity-not-high' $(if ($high) { 'FAIL' } else { 'PASS' }) 'must run at Medium integrity or lower'
$priv = (& "$SystemDir\whoami.exe" /priv) -join "`n"
$dangerous = @('SeDebugPrivilege', 'SeTakeOwnershipPrivilege', 'SeLoadDriverPrivilege', 'SeBackupPrivilege', 'SeRestorePrivilege', 'SeImpersonatePrivilege', 'SeTcbPrivilege', 'SeCreateTokenPrivilege', 'SeAssignPrimaryTokenPrivilege') | Where-Object { $priv -match $_ }
Row 'no-dangerous-privileges' $(if ($dangerous) { 'FAIL' } else { 'PASS' }) $(if ($dangerous) { "present: $($dangerous -join ', ')" } else { 'none of Debug/TakeOwnership/LoadDriver/Backup/Restore/Impersonate/Tcb/CreateToken/AssignPrimaryToken' })

# ---------------------------------------------------------------- UAC policy (HKLM is readable by standard users)
$pol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
function Get-Pol([string]$n) { $o = Get-ItemProperty -LiteralPath $pol -ErrorAction SilentlyContinue; if ($null -eq $o) { return $null }; $p = $o.PSObject.Properties[$n]; if ($null -eq $p) { return $null }; return $p.Value }
$lua = Get-Pol 'EnableLUA'; $cpu = Get-Pol 'ConsentPromptBehaviorUser'; $sd = Get-Pol 'PromptOnSecureDesktop'; $cpa = Get-Pol 'ConsentPromptBehaviorAdmin'; $fat = Get-Pol 'FilterAdministratorToken'
Row 'uac-enabled' $(if ($lua -eq 1) { 'PASS' } else { 'FAIL' }) "EnableLUA=$lua (required 1)"
Row 'uac-standard-user-auto-deny' $(if ($cpu -eq 0) { 'PASS' } else { 'FAIL' }) "ConsentPromptBehaviorUser=$cpu (required 0 = automatically deny elevation requests; 1/3 let this account raise credential prompts, a lure for the owner)"
Row 'uac-secure-desktop' $(if ($sd -eq 1) { 'PASS' } else { 'FAIL' }) "PromptOnSecureDesktop=$sd (required 1)"
Row 'uac-admin-consent' $(if ($cpa -eq 2) { 'PASS' } else { 'FAIL' }) "ConsentPromptBehaviorAdmin=$cpa (required 2: consent on the secure desktop; 0 is silent elevation)"
Row 'uac-builtin-admin-filtered' $(if ($fat -eq 1) { 'PASS' } else { 'FAIL' }) "FilterAdministratorToken=$fat (required 1)"

# ---------------------------------------------------------------- the install root
if (-not (Test-Path -LiteralPath $InstallRoot)) {
  foreach ($n in 'open-root-for-write-dac', 'open-release-for-write-dac', 'create-in-root', 'create-in-release', 'create-in-release-node_modules', 'create-in-release-runner', 'create-in-release-proof', 'create-in-state', 'create-in-state-tmp', 'create-in-evidence', 'create-in-inbox', 'mkdir-in-root', 'write-pinned-files', 'read-cred', 'open-cred-file') { Row $n 'SKIP' "install root $InstallRoot does not exist yet: run again after the elevated install" }
} else {
  foreach ($sub in @('', 'release', 'release\node_modules', 'release\scripts\qa\d24-test-runner', 'release\scripts\qa\d24-m3d-proof', 'state', 'state\tmp', 'evidence', 'inbox')) {
    $d = if ($sub) { Join-Path $InstallRoot $sub } else { $InstallRoot }
    $name = 'create-in-' + $(if ($sub) { ($sub -replace '^release\\scripts\\qa\\d24-test-runner$', 'release-runner' -replace '^release\\scripts\\qa\\d24-m3d-proof$', 'release-proof' -replace '\\', '-') } else { 'root' })
    Row-Create $name $d 'file' 'a standard user must not write the install root'
  }
  # handle-based probes: open the DIRECTORY with each dangerous access right. Nothing is modified; the handle is closed at once. Only ERROR_ACCESS_DENIED (5) is a PASS.
  foreach ($pr in @(@('', 'root'), @('release', 'release'), @('release\node_modules', 'node_modules'), @('state', 'state'))) {
    $dir = if ($pr[0]) { Join-Path $InstallRoot $pr[0] } else { $InstallRoot }
    foreach ($m in @(@(0x40000, 'write-dac'), @(0x80000, 'write-owner'), @(0x10000, 'delete'), @(0x40, 'delete-child'))) {
      $rid = 'open-' + $pr[1] + '-for-' + $m[1]
      if (-not (Test-Path -LiteralPath $dir)) { Row $rid 'SKIP' "$dir missing"; continue }
      $code = [D24Probe]::TryOpen($dir, [uint32]$m[0])
      if ($code -eq 5) { Row $rid 'PASS' "opening $dir with $($m[1]) access was refused" } elseif ($code -eq 0) { Row $rid 'FAIL' "$dir CAN be opened with $($m[1]) access (handle closed, nothing changed)" } else { Row $rid 'FAIL' "unexpected Win32 error $code opening $dir (not access-denied, so nothing is proven)" }
    }
  }
  Row-Create 'mkdir-in-root' $InstallRoot 'folder' 'creating a sub-folder (a junction/planting vector) must be refused as well'
  $pinned = @('anchor.json', 'policy.json', 'release.json') | ForEach-Object { Join-Path $InstallRoot $_ }
  $opened = @(); $missing = @(); $unexpected = @()
  foreach ($f in $pinned) {
    if (-not (Test-Path -LiteralPath $f)) { $missing += $f; continue }
    try { $fs = [IO.File]::Open($f, 'Open', 'Write', 'ReadWrite'); $fs.Close(); $opened += $f } catch [UnauthorizedAccessException] { } catch { $unexpected += "$f ($($_.Exception.GetType().Name))" }
  }
  if ($missing.Count -gt 0) { Row 'write-pinned-files' 'FAIL' "pinned file(s) missing (incomplete install?): $($missing -join ', ')" }
  elseif ($opened.Count -gt 0) { Row 'write-pinned-files' 'FAIL' "opened for write: $($opened -join ', ')" }
  elseif ($unexpected.Count -gt 0) { Row 'write-pinned-files' 'FAIL' "unexpected error (not access-denied): $($unexpected -join ', ')" }
  else { Row 'write-pinned-files' 'PASS' 'anchor.json, policy.json, release.json cannot be opened for writing' }
  $cred = Join-Path $InstallRoot 'cred'
  if (Test-Path -LiteralPath $cred) {
    Row-ReadDenied 'read-cred' $cred 'cred\ is d24run-only'
    $err = $null; $listed = $null
    try { $listed = @(Get-ChildItem -LiteralPath $cred -Force -ErrorAction Stop) } catch [UnauthorizedAccessException] { } catch { $err = $_.Exception.GetType().Name }
    if ($err) { Row 'open-cred-file' 'FAIL' "unexpected error ($err)" }
    elseif ($listed -and $listed.Count -gt 0) {
      $outcome = 'opened'
      try { $s = [IO.File]::Open($listed[0].FullName, 'Open', 'Read', 'ReadWrite'); $s.Close() } catch [UnauthorizedAccessException] { $outcome = 'denied' } catch { $outcome = ('error:' + $_.Exception.GetType().Name) }
      Row 'open-cred-file' $(if ($outcome -eq 'denied') { 'PASS' } else { 'FAIL' }) "opening a cred\ file for reading: $outcome (only access-denied passes; no content is read)"
    } else { Row 'open-cred-file' 'PASS' 'cred\ cannot be listed, so no file inside it is reachable' }
  } else { Row 'read-cred' 'SKIP' 'cred\ missing'; Row 'open-cred-file' 'SKIP' 'cred\ missing' }
}

# ---------------------------------------------------------------- the toolchain and places a junction/plant could come from
foreach ($p in @('C:\Program Files\nodejs', 'C:\Program Files\nodejs\node_modules\npm', 'C:\Program Files\Git', 'C:\Program Files\Git\mingw64\bin')) { Row-Create ('create-in-' + ($p -replace '[^A-Za-z0-9]+', '-').Trim('-').ToLower()) $p 'file' 'the elevated installer runs this binary tree' }
Row-ReadDenied 'read-dev-root' 'C:\Dev' "C:\Dev must not even be listable by the agent once tightened (the owner's ~150 checkouts and their .env* files live below it)"
Row-Create 'create-in-dev-root' 'C:\Dev' 'folder' 'C:\Dev is where an agent could plant a junction at the workspace path; tighten it (the Setup script reports it and, with -TightenDevRoot, plans the change; run Setup from the administrator account)'
if ($AdminClone) { Row-Create 'create-in-admin-clone' $AdminClone 'file' 'the administrator-owned bootstrap clone' } else { Row 'create-in-admin-clone' 'SKIP' 'pass -AdminClone <path> to test the bootstrap clone' }

# ---------------------------------------------------------------- the owner's data
$ownerPath = Join-Path $OwnerProfileRoot $OwnerUser
Row-ReadDenied 'read-owner-profile' $ownerPath "the owner's profile must be unreadable to the agent"
foreach ($sub in 'AppData\Local\DanceFlow\d24-owner', 'AppData\Local\DanceFlow\d24-runner', '.ssh', '.config\gh') { Row-ReadDenied ('read-owner-' + ($sub -replace '[^A-Za-z0-9]+', '-').ToLower()) (Join-Path $ownerPath $sub) "$sub must be unreadable" }
Row-ReadDenied 'read-owner-repository' 'C:\Dev\studioapp' "the owner's checkout (.env files, credentials) must be unreadable"

# ---------------------------------------------------------------- credential stores and environment of THIS account
$cm = (& "$SystemDir\cmdkey.exe" /list) -join "`n"
Row 'no-d24-credential-in-this-profile' $(if ($cm -match 'D24-TEST|DanceFlow/D24') { 'FAIL' } else { 'PASS' }) 'Credential Manager of this account must hold no D24 TEST credential'
$envBad = @('NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'STRIPE_SECRET_KEY', 'STRIPE_API_KEY') | Where-Object { [Environment]::GetEnvironmentVariable($_) }
Row 'no-sensitive-env' $(if ($envBad) { 'FAIL' } else { 'PASS' }) $(if ($envBad) { "set in this session: $($envBad -join ', ')" } else { 'no NODE_OPTIONS/CA/Stripe variables set' })

# ---------------------------------------------------------------- what this script cannot prove
Write-Host ''
Write-Host 'NOT TESTABLE FROM HERE (owner/administrator checks, docs section 14.4): that a UAC request from this account is really auto-denied (try one by hand, then cancel); that d24run cannot log on interactively;'
Write-Host 'that the scheduled task cannot be edited by this account; that the owner (not this account) can create in the inbox; that no administrator credentials are saved anywhere this account can read.'
$fail = @($script:Rows | Where-Object Status -eq 'FAIL').Count
$skip = @($script:Rows | Where-Object Status -eq 'SKIP').Count
Write-Host ("Result: {0} PASS, {1} FAIL, {2} SKIP" -f @($script:Rows | Where-Object Status -eq 'PASS').Count, $fail, $skip)
Write-Host 'ADVISORY only: this ran inside the agent''s own session. The authoritative checks are administrator-side (Setup dry run, docs 14.4).'
if ($fail -gt 0) { exit 1 }
if ($skip -gt 0) { Write-Host 'NOT FULLY VERIFIED (some checks were skipped).' -ForegroundColor Yellow; exit 3 }
exit 0
