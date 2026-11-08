<#
.SYNOPSIS
  One-time ADMINISTRATOR setup that moves the engineering agent to a STANDARD (non-admin) Windows user. NOT RUN by engineering: the owner reads it, then runs it once from an elevated "powershell -NoProfile" (docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md, section 14).

.DESCRIPTION
  DEFAULT IS A DRY RUN: without -Apply the script only checks state and prints what it WOULD change. With -Apply it changes only what differs
  (idempotent). It fails closed: any precondition or check it cannot evaluate stops it with a non-zero exit code and nothing further is changed.
  Every state-changing command is a one-line "Do-Change '<description>' { ... }" call so a reviewer (and a static test) can see all of them.

  What it does / checks:
    1. refuses unless: Windows, elevated, this script file is administrator-owned and not writable by non-administrators, run with -NoProfile
    2. accounts: the agent user (standard), the run-as service user d24run (no interactive logon), the owner admin: exist, group membership is exactly as required
    3. UAC policy values (HKLM ...\Policies\System): EnableLUA=1, ConsentPromptBehaviorUser=1, PromptOnSecureDesktop=1, ConsentPromptBehaviorAdmin=2, FilterAdministratorToken=1
    4. the agent workspace folder (default C:\Dev\agent-work): administrator-owned, agent MODIFY, everyone else no access
    5. READ-ONLY verification that the agent cannot read the owner's profile and the install root's cred\ (reports MANUAL steps; it never loosens or rewrites the owner's data)
  What it deliberately does NOT do: touch the owner's repositories or profile ACLs, install the runner, create the scheduled task, handle the Stripe key,
  change user rights assignments (SeDenyInteractiveLogonRight etc.: reported as MANUAL), or print/store any password.

.PARAMETER AgentUser   Existing or to-be-created standard account the agent will run as (default agentdev).
.PARAMETER RunAsUser   The service account that runs the runner (default d24run).
.PARAMETER OwnerUser   The owner's administrator account (no default: must be given).
.PARAMETER Workspace   Folder for the agent's clones (default C:\Dev\agent-work).
.PARAMETER CreateAccounts  Allow creating a missing AgentUser/RunAsUser (the AgentUser password is read as a SecureString prompt; d24run gets a random one that is discarded).
.PARAMETER Apply       Actually change things. Without it: dry run.
#>
[CmdletBinding()]
param(
  [string]$AgentUser = 'agentdev',
  [string]$RunAsUser = 'd24run',
  [Parameter(Mandatory = $true)][string]$OwnerUser,
  [string]$Workspace = 'C:\Dev\agent-work',
  [switch]$CreateAccounts,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Manual = New-Object System.Collections.Generic.List[string]
$script:Changes = 0

function Say([string]$m) { Write-Host $m }
function Fail([string]$m) { $script:Failures.Add($m); Write-Host "FAIL   $m" -ForegroundColor Red }
function Manual([string]$m) { $script:Manual.Add($m); Write-Host "MANUAL $m" -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host "OK     $m" -ForegroundColor Green }
# the ONLY place a change is executed. Dry run prints "WOULD".
function Do-Change([string]$Description, [scriptblock]$Action) {
  if (-not $Apply) { Write-Host "WOULD  $Description" -ForegroundColor Cyan; return }
  Write-Host "DO     $Description" -ForegroundColor Cyan
  & $Action
  $script:Changes++
}
function Stop-IfFailed {
  if ($script:Failures.Count -gt 0) {
    Write-Host ''
    Write-Host "STOPPED: $($script:Failures.Count) precondition/check failure(s). Nothing further was changed." -ForegroundColor Red
    exit 2
  }
}

Say "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY RUN (no change will be made; add -Apply to change)' })"

# ---------------------------------------------------------------- 1. preconditions (fail closed)
if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) { Fail 'not Windows' }
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$prin = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $prin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not running elevated (run from an elevated PowerShell started with -NoProfile)' } else { Ok 'elevated' }
if ([Environment]::GetCommandLineArgs() -notcontains '-NoProfile' -and -not ([Environment]::GetCommandLineArgs() | Where-Object { $_ -like '-nop*' })) { Fail 'PowerShell was not started with -NoProfile (an elevated shell would load a profile the agent can edit)' } else { Ok '-NoProfile' }
$self = $MyInvocation.MyCommand.Path
if (-not $self) { Fail 'cannot determine this script''s own path' } else {
  $acl = Get-Acl -LiteralPath $self
  $adminSids = @('S-1-5-32-544', 'S-1-5-18')
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($adminSids -notcontains $ownerSid) { Fail "this script file is owned by $ownerSid, not Administrators/SYSTEM: copy it to an administrator-only folder first" } else { Ok 'script file is administrator-owned' }
  $writeMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  foreach ($r in $acl.Access) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    $sid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if (($adminSids -notcontains $sid) -and (([int64]$r.FileSystemRights -band $writeMask) -ne 0)) { Fail "script file is writable by $sid" }
  }
}
Stop-IfFailed

# ---------------------------------------------------------------- 2. accounts
function Get-LocalUserOrNull([string]$n) { try { Get-LocalUser -Name $n -ErrorAction Stop } catch { $null } }
function Get-Sid($u) { $u.SID.Value }
if ($AgentUser -ieq $OwnerUser -or $RunAsUser -ieq $OwnerUser -or $AgentUser -ieq $RunAsUser) { Fail 'AgentUser, RunAsUser and OwnerUser must be three different accounts' }
$owner = Get-LocalUserOrNull $OwnerUser
if (-not $owner) { Fail "owner account '$OwnerUser' does not exist (a domain/Microsoft account owner is not handled here: report as MANUAL and re-check the group tests by hand)" }
Stop-IfFailed

$agent = Get-LocalUserOrNull $AgentUser
if (-not $agent) {
  if ($CreateAccounts) {
    if ($Apply) { $pw = Read-Host -AsSecureString "Password for the new standard user '$AgentUser' (not stored by this script)" } else { $pw = $null }
    Do-Change "create local standard user '$AgentUser'" { New-LocalUser -Name $AgentUser -Password $pw -PasswordNeverExpires:$false -AccountNeverExpires -Description 'D24 engineering agent (standard user)' | Out-Null; Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $AgentUser }
  } else { Fail "agent account '$AgentUser' does not exist (re-run with -CreateAccounts or create it yourself)" }
} else { Ok "agent account '$AgentUser' exists" }

$runas = Get-LocalUserOrNull $RunAsUser
if (-not $runas) {
  if ($CreateAccounts) {
    Do-Change "create local service user '$RunAsUser' with a random password that is discarded (not interactive; password never shown)" { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $p = ConvertTo-SecureString ([Convert]::ToBase64String($b) + 'aA1!') -AsPlainText -Force; New-LocalUser -Name $RunAsUser -Password $p -PasswordNeverExpires -UserMayNotChangePassword -Description 'D24 runner service account' | Out-Null }
  } else { Fail "run-as account '$RunAsUser' does not exist (re-run with -CreateAccounts or create it yourself)" }
} else { Ok "run-as account '$RunAsUser' exists" }
Stop-IfFailed

# group membership must be exactly: agent = Users only; d24run = not an administrator, not in the agent's groups
$adminGroup = Get-LocalGroup -SID 'S-1-5-32-544'
$admins = @(Get-LocalGroupMember -Group $adminGroup | ForEach-Object { $_.SID.Value })
foreach ($n in @($AgentUser, $RunAsUser)) {
  $u = Get-LocalUserOrNull $n
  if ($u -and ($admins -contains (Get-Sid $u))) {
    $sidU = Get-Sid $u
    Do-Change "REMOVE '$n' from the local Administrators group" { Remove-LocalGroupMember -Group $adminGroup -Member $n }
    if (-not $Apply) { Fail "'$n' is currently an administrator (dry run: would be removed with -Apply; a dry run still fails so that nobody mistakes it for a pass)" }
  } elseif ($u) { Ok "'$n' is not an administrator" }
}
$powerGroups = @('S-1-5-32-551', 'S-1-5-32-547', 'S-1-5-32-580', 'S-1-5-32-573')   # Backup Operators, Power Users, Remote Management Users, Event Log Readers
foreach ($g in $powerGroups) {
  try { $grp = Get-LocalGroup -SID $g -ErrorAction Stop } catch { continue }
  $m = @(Get-LocalGroupMember -Group $grp | ForEach-Object { $_.SID.Value })
  foreach ($n in @($AgentUser, $RunAsUser)) { $u = Get-LocalUserOrNull $n; if ($u -and ($m -contains (Get-Sid $u))) { Fail "'$n' is a member of privileged group $($grp.Name)" } }
}
if (@(Get-LocalUserOrNull $RunAsUser).Count -gt 0) {
  $u = Get-LocalUserOrNull $RunAsUser
  if ($u.Enabled -eq $false) { Manual "'$RunAsUser' is disabled: enable it before creating the scheduled task" }
}
Manual "Deny '$RunAsUser' interactive and remote logon and allow 'Log on as a batch job' (Local Security Policy > User Rights Assignment: 'Deny log on locally', 'Deny log on through Remote Desktop Services', 'Log on as a batch job'). Not changed by this script."
Manual "Create the scheduled task for '$RunAsUser' (docs section 12.3 step 1); not done here."
Stop-IfFailed

# ---------------------------------------------------------------- 3. UAC policy
$pol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$want = [ordered]@{
  EnableLUA = 1                     # UAC on
  ConsentPromptBehaviorUser = 1     # standard users: prompt for CREDENTIALS on the secure desktop (0 = automatically deny, also acceptable)
  PromptOnSecureDesktop = 1         # the prompt runs on the secure desktop
  ConsentPromptBehaviorAdmin = 2    # administrators: consent prompt on the secure desktop (no silent elevation)
  FilterAdministratorToken = 1      # the built-in Administrator account also runs filtered
}
foreach ($k in $want.Keys) {
  $have = (Get-ItemProperty -LiteralPath $pol -Name $k -ErrorAction SilentlyContinue).$k
  if ($have -ne $want[$k]) {
    if ($k -eq 'ConsentPromptBehaviorUser' -and $have -eq 0) { Ok "$k = 0 (automatically deny elevation requests): at least as strict as the required 1"; continue }
    Do-Change "set $k = $($want[$k]) (was $(if ($null -eq $have) { 'not set' } else { $have }))" { Set-ItemProperty -LiteralPath $pol -Name $k -Value $want[$k] -Type DWord }
  } else { Ok "$k = $have" }
}
Manual 'A change to EnableLUA needs a restart to take effect.'

# ---------------------------------------------------------------- 4. agent workspace
$ag = Get-LocalUserOrNull $AgentUser
if ($ag) {
  if (-not (Test-Path -LiteralPath $Workspace)) { Do-Change "create the agent workspace '$Workspace'" { New-Item -ItemType Directory -Path $Workspace | Out-Null } }
  if ($Apply -or (Test-Path -LiteralPath $Workspace)) {
    $agSid = Get-Sid $ag
    Do-Change "set owner Administrators and ACL on '$Workspace': Administrators+SYSTEM full, '$AgentUser' modify, no inheritance" { & "$env:SystemRoot\System32\icacls.exe" $Workspace /setowner '*S-1-5-32-544' /T | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls setowner failed' }; & "$env:SystemRoot\System32\icacls.exe" $Workspace /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "*${agSid}:(OI)(CI)M" /T | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls grant failed' } }
  }
}
Stop-IfFailed

# ---------------------------------------------------------------- 5. read-only checks of what must NOT be reachable from the agent
function Test-AgentCannotRead([string]$path, [string]$what) {
  if (-not (Test-Path -LiteralPath $path)) { Say "SKIP   $what ($path does not exist)"; return }
  $acl = Get-Acl -LiteralPath $path
  $agSid = (Get-LocalUserOrNull $AgentUser).SID.Value
  $groups = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', $agSid)   # Everyone, Authenticated Users, Users, the agent
  $readMask = 0x1 -bor 0x20 -bor 0x80000000 -bor 0x20000000 -bor 0x10000000 -bor 0x1f01ff
  $bad = @()
  foreach ($r in $acl.Access) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    $sid = $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if (($groups -contains $sid) -and (([int64]$r.FileSystemRights -band 0x1) -ne 0)) { $bad += $sid }
  }
  if ($bad.Count -gt 0) { Manual "$what ($path) grants read to $($bad -join ', ') which includes the agent: tighten it as an administrator (this script does not rewrite the owner's data)" } else { Ok "$what ($path) grants no read to the agent's groups" }
}
$ownerProfile = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq (Get-Sid $owner) } | Select-Object -First 1).LocalPath
if ($ownerProfile) { Test-AgentCannotRead $ownerProfile "owner profile" } else { Manual "could not locate the owner's profile folder" }
Test-AgentCannotRead 'C:\Dev\studioapp' 'owner repository checkout (.env files and credentials)'
Test-AgentCannotRead 'C:\ProgramData\d24-runner\cred' 'install root cred\'
Manual "Move the agent's work to '$Workspace' under '$AgentUser' (docs section 14.2): clones, Claude sign-in, git/gh credentials, node toolchain. Nothing is copied by this script."

# ---------------------------------------------------------------- summary
Write-Host ''
Write-Host ("Summary: {0} change(s) {1}; {2} manual step(s); {3} failure(s)." -f $script:Changes, $(if ($Apply) { 'made' } else { 'WOULD be made (dry run)' }), $script:Manual.Count, $script:Failures.Count)
if ($script:Failures.Count -gt 0) { exit 2 }
if (-not $Apply) { exit 10 }   # a dry run never reports success
exit 0
