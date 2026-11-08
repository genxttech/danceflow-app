<#
.SYNOPSIS
  One-time ADMINISTRATOR setup that moves the engineering agent to a STANDARD (non-admin) Windows user. NOT RUN by engineering: the owner reads it, obtains it
  from the administrator-owned bootstrap clone (docs/billing/D24-TEST-RUNNER-TRUST-ANCHOR.md section 14.6), and runs it once from an elevated "powershell -NoProfile"
  that was started from a FRESH administrator account (14.6).

.DESCRIPTION
  Three phases, strictly in this order:
    1. CHECK   read-only. Every precondition and the full set of intended changes are evaluated first. Any failure -> exit 2, NOTHING has been changed.
    2. PLAN    the exact list of changes is printed ("WOULD ..." in a dry run).
    3. APPLY   only with -Apply AND only if phase 1 found no failure. Each change is idempotent (it is planned only when the current state differs). If an action throws, the
               script stops, lists what was done and what was not, and exits 2; re-running is safe.
  DEFAULT IS A DRY RUN. A dry run exits 10 (never 0). Every state-changing command is on a visible "Add-Plan '<description>' ({ ... }" line.

  Hardening of the script itself: PSModulePath is reduced to the Windows PowerShell inbox modules BEFORE anything is resolved; the LocalAccounts module is imported from its
  full System32 path; all binaries are fixed paths (never taken from environment variables); registry values are read defensively (StrictMode-safe); security descriptors are read with .NET, not
  Get-Acl/CIM; the script file AND its folder must be administrator-owned and not writable by anyone else.

  It NEVER: recurses ACL changes over a tree (no recursive icacls switch anywhere; a reparse point in the workspace cannot redirect it), touches the owner's repositories or profile,
  prints or stores a password, changes user-rights assignments (reported as MANUAL), installs the runner, creates the scheduled task, or handles the Stripe key.

.PARAMETER AgentUser   Standard account the agent will run as (default agentdev). Must NOT be the account running this script.
.PARAMETER RunAsUser   The runner's service account (default d24run).
.PARAMETER OwnerUser   The owner's enabled administrator account (mandatory).
.PARAMETER Workspace   The agent's folder. Fixed default C:\Dev\agent-work; must be a new, non-existing folder (or already carry exactly the expected descriptor).
.PARAMETER CreateAccounts  Allow creating missing AgentUser/RunAsUser (AgentUser's password is read as a SecureString prompt during APPLY; d24run gets a random one nobody keeps).
.PARAMETER Apply       Make the changes. Without it: dry run.
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
# --- module / environment hygiene BEFORE anything else is resolved --------------------------------------------------------------------------
$env:PSModulePath = Join-Path $PSHOME 'Modules'
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$SystemDir = 'C:\Windows\System32'
$Icacls = "$SystemDir\icacls.exe"
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Manual = New-Object System.Collections.Generic.List[string]
$script:Plan = New-Object System.Collections.Generic.List[object]
$ADMINS = 'S-1-5-32-544'; $SYSTEM = 'S-1-5-18'

function Say([string]$m) { Write-Host $m }
function Fail([string]$m) { $script:Failures.Add($m); Write-Host "FAIL   $m" -ForegroundColor Red }
function Manual([string]$m) { $script:Manual.Add($m); Write-Host "MANUAL $m" -ForegroundColor Yellow }
function Ok([string]$m) { Write-Host "OK     $m" -ForegroundColor Green }
# the ONLY way a change is registered. Nothing runs until phase 3.
function Add-Plan([string]$Description, [scriptblock]$Action) { $script:Plan.Add([pscustomobject]@{ Description = $Description; Action = $Action }) }
# StrictMode-safe registry read: $null when the key or value is absent
function Get-RegValue([string]$Path, [string]$Name) {
  $o = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $o) { return $null }
  $p = $o.PSObject.Properties[$Name]
  if ($null -eq $p) { return $null }
  return $p.Value
}
function Get-Sddl([string]$Path) { (Get-Item -LiteralPath $Path -Force).GetAccessControl().GetSecurityDescriptorSddlForm('Owner,Access') }
function Test-Reparse([string]$Path) { return [bool]((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
function Get-OwnerSid([string]$Path) { (Get-Item -LiteralPath $Path -Force).GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value }
# problems if the path is not administrator-owned or is writable by anyone but Administrators/SYSTEM
function Test-AdminOnly([string]$Path) {
  $problems = @()
  $item = Get-Item -LiteralPath $Path -Force
  $acl = $item.GetAccessControl()
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (@($ADMINS, $SYSTEM) -notcontains $ownerSid) { $problems += "owned by $ownerSid, not Administrators/SYSTEM" }
  $writeMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    $sid = $r.IdentityReference.Value
    if ((@($ADMINS, $SYSTEM) -notcontains $sid) -and (([int64]$r.FileSystemRights -band $writeMask) -ne 0)) { $problems += "writable by $sid" }
  }
  return $problems
}
function Get-LocalUserOrNull([string]$n) { try { Get-LocalUser -Name $n -ErrorAction Stop } catch { $null } }

Say "Mode: $(if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing will be changed; add -Apply to change)' })"

# ================================================================ PHASE 1: CHECK (read-only)
if ($PSVersionTable.PSEdition -eq 'Core') { Fail 'run this under Windows PowerShell 5.1 (powershell.exe), not PowerShell 7' }
$cmdArgs = [Environment]::GetCommandLineArgs()
if (-not ($cmdArgs | Where-Object { $_ -like '-nop*' })) { Fail 'PowerShell was not started with -NoProfile (an elevated shell would load a profile the agent can edit)' } else { Ok '-NoProfile' }
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$me = $id.User.Value
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not running elevated' } else { Ok 'elevated' }
$lam = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.LocalAccounts\Microsoft.PowerShell.LocalAccounts.psd1'
if (-not (Test-Path -LiteralPath $lam)) { Fail "inbox LocalAccounts module not found at $lam" } else { Import-Module -Name $lam -ErrorAction Stop; Ok 'LocalAccounts module imported from the inbox path' }
$self = $MyInvocation.MyCommand.Path
if (-not $self) { Fail 'cannot determine this script''s own path' } else {
  $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($self))).Replace('-', '').ToLower()
  Say "script sha256: $sha  (compare with the hash of this file in the reviewed commit)"
  foreach ($p in @($self, (Split-Path -Parent $self))) { $pr = Test-AdminOnly $p; if ($pr.Count -gt 0) { Fail "$p : $($pr -join '; ') (copy the script to an administrator-only folder, e.g. from the bootstrap clone)" } else { Ok "$p is administrator-only" } }
}
if (@($AgentUser, $RunAsUser, $OwnerUser | ForEach-Object { $_.ToLower() } | Select-Object -Unique).Count -ne 3) { Fail 'AgentUser, RunAsUser and OwnerUser must be three different accounts' }

$owner = if ($script:Failures.Count -eq 0) { Get-LocalUserOrNull $OwnerUser } else { $null }
$agent = $null; $runas = $null
$adminSids = @()
if ($script:Failures.Count -eq 0) {
  $adminGroup = Get-LocalGroup -SID $ADMINS
  $adminSids = @(Get-LocalGroupMember -Group $adminGroup | ForEach-Object { $_.SID.Value })
  if (-not $owner) { Fail "owner account '$OwnerUser' is not a local account (domain/Microsoft-account owners are not handled here: stop and ask engineering)" }
  elseif (-not $owner.Enabled) { Fail "owner account '$OwnerUser' is disabled" }
  elseif ($adminSids -notcontains $owner.SID.Value) { Fail "owner account '$OwnerUser' is not a member of Administrators" }
  else { Ok "owner '$OwnerUser' is an enabled administrator" }
  $agent = Get-LocalUserOrNull $AgentUser
  $runas = Get-LocalUserOrNull $RunAsUser
  # lockout guard
  if ($agent -and ($agent.SID.Value -eq $me)) { Fail "AgentUser '$AgentUser' is the account running this script: refusing (it would be demoted and you would lock yourself out)" }
  if ($runas -and ($runas.SID.Value -eq $me)) { Fail "RunAsUser '$RunAsUser' is the account running this script: refusing" }
  foreach ($u in @($agent, $runas)) { if ($u -and $u.SID.Value.EndsWith('-500')) { Fail "'$($u.Name)' is the built-in Administrator (RID 500): refusing" } }
  $remaining = @($adminSids | Where-Object { ($null -eq $agent -or $_ -ne $agent.SID.Value) -and ($null -eq $runas -or $_ -ne $runas.SID.Value) })
  $enabledRemaining = @($remaining | Where-Object { $s = $_; $lu = Get-LocalUser -SID $s -ErrorAction SilentlyContinue; $lu -and $lu.Enabled })
  if ($enabledRemaining.Count -lt 1) { Fail 'removing the agent/run-as accounts from Administrators would leave NO enabled administrator: refusing' } else { Ok "$($enabledRemaining.Count) enabled administrator(s) remain after the change" }
}
# accounts and groups
if ($script:Failures.Count -eq 0) {
  foreach ($pair in @(@($AgentUser, $agent), @($RunAsUser, $runas))) {
    $n = $pair[0]; $u = $pair[1]
    if (-not $u) {
      if ($CreateAccounts) { Ok "'$n' will be created (-CreateAccounts)" } else { Fail "account '$n' does not exist (re-run with -CreateAccounts or create it yourself)" }
    } else {
      Ok "account '$n' exists"
      if ($adminSids -contains $u.SID.Value) { Say "NOTE   '$n' is currently an administrator: will be removed from Administrators" }
      foreach ($g in @('S-1-5-32-551', 'S-1-5-32-547', 'S-1-5-32-580', 'S-1-5-32-573')) {   # Backup Operators, Power Users, Remote Management Users, Event Log Readers
        $grp = Get-LocalGroup -SID $g -ErrorAction SilentlyContinue
        if ($grp -and (@(Get-LocalGroupMember -Group $grp | ForEach-Object { $_.SID.Value }) -contains $u.SID.Value)) { Fail "'$n' is a member of privileged group $($grp.Name): remove it by hand" }
      }
    }
  }
}
# UAC policy: read defensively, plan only what differs
$pol = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$want = [ordered]@{
  EnableLUA = 1                     # UAC on (a change needs a restart)
  ConsentPromptBehaviorUser = 0     # standard users: AUTOMATICALLY DENY elevation requests (the agent never needs to elevate; a credential prompt it can raise is a lure for the owner)
  PromptOnSecureDesktop = 1
  ConsentPromptBehaviorAdmin = 2    # administrators: consent on the secure desktop, no silent elevation
  FilterAdministratorToken = 1      # the built-in Administrator also runs filtered
}
foreach ($k in $want.Keys) {
  $have = Get-RegValue $pol $k
  if ($have -ne $want[$k]) {
    $keyName = $k; $val = $want[$k]
    Add-Plan "set HKLM $keyName = $val (was $(if ($null -eq $have) { 'not set' } else { $have }))" ({ if (-not (Test-Path -LiteralPath $pol)) { throw "policy key $pol is missing" }; Set-ItemProperty -LiteralPath $pol -Name $keyName -Value $val -Type DWord }.GetNewClosure())
  } else { Ok "$k = $have" }
}
# the agent workspace: a NEW folder, never recursed over
$wsFull = $null
try { $wsFull = [IO.Path]::GetFullPath($Workspace).TrimEnd('\') } catch { Fail "Workspace '$Workspace' is not a valid path" }
if ($wsFull) {
  $drive = [IO.Path]::GetPathRoot($wsFull)
  if ($wsFull -ne $Workspace.TrimEnd('\') -or $wsFull -eq $drive.TrimEnd('\') -or $wsFull -notmatch '^[A-Za-z]:\\[^\\]+(\\[^\\]+)*$') { Fail "Workspace must be a normalised absolute folder path below a drive root (got '$Workspace')" }
  foreach ($bad in @('C:\Windows', 'C:\Program Files', 'C:\Program Files (x86)', 'C:\ProgramData', 'C:\Users', 'C:\Dev\studioapp')) {
    if ($wsFull -eq $bad -or $wsFull.StartsWith("$bad\", [StringComparison]::OrdinalIgnoreCase) -or $bad.StartsWith("$wsFull\", [StringComparison]::OrdinalIgnoreCase)) { Fail "Workspace '$wsFull' overlaps protected location '$bad'" }
  }
  $parent = Split-Path -Parent $wsFull
  if (-not (Test-Path -LiteralPath $parent)) { Fail "parent folder '$parent' does not exist" }
  elseif (Test-Reparse $parent) { Fail "parent folder '$parent' is a junction/symlink" }
}
$agentSidKnown = if ($agent) { $agent.SID.Value } else { $null }
if ($wsFull -and $script:Failures.Count -eq 0) {
  $aclApply = {
    param($ws, $sid)
    & $Icacls $ws /setowner "*$ADMINS" | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls /setowner failed' }
    & $Icacls $ws /inheritance:r /grant:r "*${ADMINS}:(OI)(CI)F" "*${SYSTEM}:(OI)(CI)F" "*${sid}:(OI)(CI)M" | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls /grant failed' }
  }
  if (Test-Path -LiteralPath $wsFull) {
    if (Test-Reparse $wsFull) { Fail "Workspace '$wsFull' is a junction/symlink: remove it (as an administrator) and re-run" }
    elseif ($agentSidKnown) {
      $sddl = Get-Sddl $wsFull
      $expected = '^O:BAG:[A-Z]{2}D:P(AI)?\(A;OICI;FA;;;BA\)\(A;OICI;FA;;;SY\)\(A;OICI;0x1301bf;;;' + [regex]::Escape($agentSidKnown) + '\)$'
      if ($sddl -match $expected) { Ok "Workspace '$wsFull' already has exactly the expected owner and ACL" }
      elseif (@(Get-ChildItem -LiteralPath $wsFull -Force).Count -eq 0) { $w = $wsFull; $s = $agentSidKnown; Add-Plan "set owner Administrators and the ACL on the EMPTY existing folder '$w' (this folder only, no recursion)" ({ & $aclApply $w $s }.GetNewClosure()) }
      else { Fail "Workspace '$wsFull' exists, is not empty and does not carry the expected descriptor: this script will not touch agent-controlled content (inspect it as an administrator)" }
    } else { Fail "Workspace '$wsFull' exists but the agent account does not: remove the folder or create the account first" }
  } else {
    $w = $wsFull; $ag = $AgentUser
    Add-Plan "create the NEW workspace folder '$w', then set owner Administrators and ACL (Administrators+SYSTEM full, '$AgentUser' modify, no inheritance) on that folder only" ({
      New-Item -ItemType Directory -Path $w -ErrorAction Stop | Out-Null
      if (Test-Reparse $w) { throw "'$w' became a link while being created" }
      $sid = (Get-LocalUser -Name $ag).SID.Value
      & $aclApply $w $sid
      if (@(Get-ChildItem -LiteralPath $w -Force).Count -ne 0) { throw "'$w' is not empty after creation (something was planted): inspect it as an administrator" }
    }.GetNewClosure())
  }
}
# accounts to create / demote (planned only when they differ)
if ($script:Failures.Count -eq 0) {
  if (-not $agent -and $CreateAccounts) {
    $n = $AgentUser
    Add-Plan "create local standard user '$n' (password prompted as a SecureString of at least 12 characters, never stored)" ({ $pw = Read-Host -AsSecureString "Password for the new standard user '$n'"; if ($pw.Length -lt 12) { throw 'password shorter than 12 characters' }; New-LocalUser -Name $n -Password $pw -AccountNeverExpires -Description 'D24 engineering agent (standard user)' | Out-Null; Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $n }.GetNewClosure())
  }
  if (-not $runas -and $CreateAccounts) {
    $n = $RunAsUser
    Add-Plan "create local service user '$n' with a random password that is discarded (never shown or stored)" ({ $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $p = ConvertTo-SecureString ([Convert]::ToBase64String($b) + 'aA1!') -AsPlainText -Force; New-LocalUser -Name $n -Password $p -PasswordNeverExpires -UserMayNotChangePassword -Description 'D24 runner service account' | Out-Null }.GetNewClosure())
  }
  foreach ($u in @($agent, $runas)) { if ($u -and ($adminSids -contains $u.SID.Value)) { $nm = $u.Name; Add-Plan "REMOVE '$nm' from the local Administrators group" ({ Remove-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-544') -Member $nm }.GetNewClosure()) } }
}
# read-only reachability report
function Get-AgentSids {
  $set = @($agentSidKnown, 'S-1-1-0', 'S-1-5-11', 'S-1-5-4', 'S-1-2-1', 'S-1-5-32-545') | Where-Object { $_ }
  if ($agent) { foreach ($g in @(Get-LocalGroup)) { if (@(Get-LocalGroupMember -Group $g -ErrorAction SilentlyContinue | ForEach-Object { $_.SID.Value }) -contains $agentSidKnown) { $set += $g.SID.Value } } }
  return @($set | Select-Object -Unique)
}
function Test-AgentCannotRead([string]$path, [string]$what) {
  if (-not (Test-Path -LiteralPath $path)) { Say "SKIP   $what ($path does not exist)"; return }
  try {
    $sids = Get-AgentSids
    $bad = @()
    foreach ($r in (Get-Item -LiteralPath $path -Force).GetAccessControl().GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -ne 'Allow') { continue }
      $mask = [int64]$r.FileSystemRights
      if (($sids -contains $r.IdentityReference.Value) -and (($mask -band 0x1) -ne 0 -or ($mask -band 0x80000000) -ne 0 -or ($mask -band 0x10000000) -ne 0)) { $bad += $r.IdentityReference.Value }
    }
    if ($bad.Count -gt 0) { Manual "$what ($path) grants read to $(($bad | Select-Object -Unique) -join ', '), which the agent holds: tighten it as an administrator (this script never rewrites the owner's data). Checked on the top-level folder only." } else { Ok "$what ($path): no read grant to the agent's SIDs on the top-level folder" }
  } catch { Manual "$what ($path): could not be evaluated ($($_.Exception.Message))" }
}
if ($owner) {
  $ownerProfile = Get-RegValue ("HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + $owner.SID.Value) 'ProfileImagePath'
  if ($ownerProfile) { Test-AgentCannotRead $ownerProfile 'owner profile' } else { Manual "could not locate the owner's profile folder" }
  Test-AgentCannotRead 'C:\Dev\studioapp' 'owner repository checkout (.env files and credentials)'
  Test-AgentCannotRead 'C:\ProgramData\d24-runner\cred' 'install root cred\'
}
Manual "Deny '$RunAsUser' interactive and remote logon and allow 'Log on as a batch job' (Local Security Policy > User Rights Assignment). Not changed by this script. d24run has a discarded password: register the scheduled task with a method that works with DPAPI (test U3); if 'run whether user is logged on or not' needs a password, reset d24run's password then, once, as an administrator."
Manual "EnableLUA changes need a restart. After setup, sign in as '$AgentUser' on its OWN logon session (never 'runas /user:$AgentUser' onto the owner's desktop: windows of equal integrity can drive each other)."
Manual "Move the agent's work to '$Workspace' under '$AgentUser' (docs section 14.2)."

# ================================================================ PHASE 2: PLAN
Write-Host ''
if ($script:Failures.Count -gt 0) {
  Write-Host "STOPPED: $($script:Failures.Count) failure(s). Nothing was changed." -ForegroundColor Red
  exit 2
}
Say "Plan: $($script:Plan.Count) change(s)"
$i = 0
foreach ($a in $script:Plan) { $i++; Write-Host ("{0} {1}/{2}  {3}" -f $(if ($Apply) { 'DO    ' } else { 'WOULD ' }), $i, $script:Plan.Count, $a.Description) -ForegroundColor Cyan }
if (-not $Apply) { Write-Host "Dry run: $($script:Manual.Count) manual step(s) listed above; no change made."; exit 10 }   # a dry run never reports success

# ================================================================ PHASE 3: APPLY
$done = New-Object System.Collections.Generic.List[string]
try {
  foreach ($a in $script:Plan) { & $a.Action; $done.Add($a.Description) }
} catch {
  Write-Host ''
  Write-Host "ABORTED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Completed ($($done.Count) of $($script:Plan.Count)):"; $done | ForEach-Object { Write-Host "  - $_" }
  Write-Host 'The remaining changes were NOT applied. Fix the cause and re-run: only differing state is planned again.'
  exit 2
}
Write-Host ''
Write-Host "Applied $($done.Count) change(s); $($script:Manual.Count) manual step(s) remain (listed above)."
exit 0
