<#
.SYNOPSIS
  TW-4 Stage B launcher (LEGACY; only -DryRun runs): seeds a LOCAL test studio and runs the FAKE adapter for steps S1-S10 ONLY. Its former real mode is retired. Originally: asked YOU to authorize, then ran the real adapter for steps S1-S10 ONLY
  (draft Trust Hub resources + profile evaluation; nothing is submitted to Twilio review; no brand; no fee).

.DESCRIPTION
  RETIRED: real mode (no -DryRun) is refused with exit code 2 and never contacts Twilio (see the guard below). Only -DryRun and -DryRun -Interactive run.
  The text below describes the retired real flow and is kept as the record of what the harness did.
  What it does, in order, asking before each consequential step:
    1  checks the local Supabase stack (Docker) and that nothing here can reach shared DEV/PROD (loopback only);
    2  prompts for: Account SID, Standard API key SID and secret (hidden; Ctrl+V, right-click paste or Enter-from-clipboard all work), the
       compliance mailbox (you must type CONFIRMED to state it exists and is monitored), the EIN (hidden), and the business JSON file
       (copy stage-b-business.template.json and fill it in);
    3  validates everything locally BEFORE any call;
    4  seeds a throwaway LOCAL test studio (random id) with an encrypted EIN;
    5  \`authorize-b\`: the harness itself asks YOU to type a phrase naming the studio. An automated session cannot do this;
    6  you type RUN to start; the harness runs S1-S10 only (positional stop, ledger precondition, network fence that blocks any submit,
       trust product or brand request);
    7  saves the Twilio resource inventory (SIDs) to a NEW evidence file and, if you agree, cleans up the LOCAL fixtures.
  The Standard API key is the ONLY credential used: the account auth token is never read, not even as a fallback.
  Credentials live in this process and its child processes only, are never written to disk or printed, and are cleared in a finally block.
  -DryRun is a COMPLETE NON-INTERACTIVE self-test of this whole flow with built-in synthetic values and the FAKE adapter against the
  local database: no prompts, no network, no Twilio contact. It also checks that the harness CLI refuses the retired real mode.
  -DryRun -Interactive uses the real prompts (any synthetic values) with the fake adapter.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\run-stage-b.ps1 -DryRun
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\run-stage-b.ps1 -DryRun -Interactive
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Interactive,
  [string]$BusinessFile,
  [int]$AuthMinutes = 30,
  [string]$LocalUrl = "http://127.0.0.1:55321",
  [string]$DbContainer = "supabase_db_danceflow-e2e-qa",
  [string]$AuthContainer = "supabase_auth_danceflow-e2e-qa"
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
Set-PSDebug -Off

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:ClipboardTextUsed = $null
if ($Interactive -and -not $DryRun) { Write-Host "REFUSED (exit code 2): -Interactive is only meaningful together with -DryRun." -ForegroundColor Yellow; exit 2 }
$UseDryRunDefaults = $DryRun -and -not $Interactive
# Real mode of this legacy launcher is RETIRED. It writes to the one account whose SID and key it is given (the parent account), while every studio now
# has its own Twilio subaccount, and it cannot verify which account a credential belongs to. There is deliberately no switch, flag or environment variable
# that re-enables it (the same refusal is in stage-bc.ts, scripts/tw4-validation/legacyGuard.ts). -DryRun (fake adapter, local database) is unaffected.
if (-not $DryRun) {
  Write-Host "REFUSED (exit code 2): real mode of the legacy Stage B launcher is retired. Nothing was sent to Twilio." -ForegroundColor Yellow
  Write-Host "Why: this launcher writes to the single account whose Account SID and API key it is given (the parent account). Each studio legal business now has its own"
  Write-Host "Twilio subaccount, and the launcher cannot verify which account a credential belongs to, so it could put a studio's identity data in the wrong account."
  Write-Host "Use instead: the production onboarding runner (platform panel): create the studio's subaccount (G-SUB), then the runner's steps S1-S10 run inside it with the"
  Write-Host "subaccount's own credentials. See docs/twilio/TW-4_StageB_Execution_Runbook.md section 0 and docs/twilio/TW-4F_Production_Onboarding_Plan.md section 13."
  Write-Host "Still available: -DryRun (fake adapter, local database, no network) and -DryRun -Interactive."
  exit 2
}

# Test seam: honoured ONLY in the non-interactive dry run, so it can never feed values to a real run.
function Get-TestInput([string]$Name) {
  if ($UseDryRunDefaults) { return [Environment]::GetEnvironmentVariable($Name) }
  return $null
}

# Verified values from Stage A and Twilio's ISV guide (public identifiers, not secrets).
$Ids = @{
  PrimaryProfileSid = "BUed777b1ed81df271793fbd097324ec94"
  PrimaryPolicySid  = "RN6433641899984f951173ef1738c3bdd0"
  SecondaryPolicy   = "RNdfbf3fae0e1107f8aded0e7cead80bf5"
  A2pPolicy         = "RNb0d4771c2c98518d916a3d4cd70a8f8b"
}
# Built-in synthetic values for -DryRun. Not real credentials, not a real business.
$Dry = @{
  Account = "AC" + ("0" * 32)
  KeySid  = "SK" + ("0" * 32)
  Secret  = "selftestselftestselftestselftest"
  Email   = "dryrun@example.test"
  Ein     = "11-2223333"
}
$RequiredBusinessFields = @("legal_name", "entity_type", "industry", "website_choice", "address_line1", "city", "region", "postal_code", "rep_first_name", "rep_last_name", "rep_title", "rep_position", "rep_email", "rep_phone", "preferred_area_code")
$OptionalBusinessFields = @("website_url", "address_line2")
$EntityTypes = @("llc", "corporation", "partnership", "non_profit", "cooperative")
$Industries = @("EDUCATION", "CONSUMER")
$Positions = @("ceo", "director", "gm", "vp", "cfo", "general_counsel", "other")

# Shared hidden-entry and validation helpers (also used by run-stage-a.ps1).
. (Join-Path $PSScriptRoot "launcher-common.ps1")

function Write-Step([string]$Text) { Write-Host ""; Write-Host "== $Text" -ForegroundColor Cyan }

function Test-BusinessFile([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return "No business file given." }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "That file does not exist." }
  try { $j = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return "That file is not valid JSON." }
  $names = @($j.PSObject.Properties.Name)
  foreach ($f in $RequiredBusinessFields) {
    if ($names -notcontains $f) { return "Field '$f' is missing." }
    $v = [string]$j.$f
    if ([string]::IsNullOrWhiteSpace($v)) { return "Field '$f' is empty." }
    if ($v.TrimStart().StartsWith("<") -or $v -match 'TODO') { return "Field '$f' still holds a placeholder." }
  }
  foreach ($f in $names) { if (($RequiredBusinessFields + $OptionalBusinessFields) -notcontains $f) { return "Unknown field '$f'." } }
  # The subject of a Secondary profile is a STUDIO; the ISV's own legal identity (GenX TotalTech LLC / DanceFlow) is never accepted.
  if (([string]$j.legal_name).ToLowerInvariant() -replace '[^a-z0-9]', '' -match 'genx|totaltech') { return "legal_name is the ISV's own legal identity; a Secondary profile must describe a studio (a different legal entity)." }
  if (([string]$j.rep_email).ToLowerInvariant() -match '@idanceflow\.com$') { return "rep_email is a DanceFlow address; the representative must be the studio's own authorized person." }
  if ($EntityTypes -notcontains [string]$j.entity_type) { return "entity_type must be one of: $($EntityTypes -join ', ')." }
  if ($Industries -notcontains [string]$j.industry) { return "industry must be one of: $($Industries -join ', ')." }
  if ($Positions -notcontains [string]$j.rep_position) { return "rep_position must be one of: $($Positions -join ', ')." }
  if ([string]$j.region -notmatch '^[A-Za-z]{2}$') { return "region must be a 2-letter state code." }
  if ([string]$j.postal_code -notmatch '^\d{5}(-\d{4})?$') { return "postal_code must be a US ZIP code." }
  if ([string]$j.preferred_area_code -notmatch '^\d{3}$') { return "preferred_area_code must be 3 digits." }
  if ([string]$j.rep_email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { return "rep_email is not a valid email address." }
  return $null
}

# Runs the harness (stage-bc.ts) and returns exit code + captured stdout. stderr (prompts, refusals, warnings) stays on the console.
function Invoke-Harness([string[]]$HarnessArgs, [hashtable]$ExtraEnv, [switch]$ClosedStdin, [switch]$CaptureStderr) {
  $saved = @{}
  $errFile = $null; $errText = ""
  foreach ($k in $ExtraEnv.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process"); [Environment]::SetEnvironmentVariable($k, [string]$ExtraEnv[$k], "Process") }
  $code = 2; $stdout = @()
  Push-Location $RepoRoot
  try {
    $ErrorActionPreference = "Continue" # native stderr lines must not become terminating errors
    $cli = @("tsx", "--tsconfig", "scripts/tw4-validation/tsconfig.json", "scripts/tw4-validation/stage-bc.ts") + $HarnessArgs
    if ($CaptureStderr) {
      $errFile = Join-Path $env:TEMP ("tw4-stderr-" + [guid]::NewGuid().ToString("N") + ".txt")
      if ($ClosedStdin) { $stdout = @("" | & npx.cmd @cli 2> $errFile) } else { $stdout = @(& npx.cmd @cli 2> $errFile) }
    }
    elseif ($ClosedStdin) { $stdout = @("" | & npx.cmd @cli) }
    else { $stdout = @(& npx.cmd @cli) }
    $code = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = "Stop"
    if ($errFile -and (Test-Path -LiteralPath $errFile)) { $errText = (Get-Content -LiteralPath $errFile -Raw); Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue }
    Pop-Location
    foreach ($k in $ExtraEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], "Process") }
  }
  return [pscustomobject]@{ Code = $code; Out = $stdout; Err = $errText }
}

# Strict-mode-safe property read (a missing property is $null, not an exception).
function Get-Prop($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function Write-CleanupHelp {
  Write-Host "  To clean up the LOCAL fixtures later (the Twilio draft resources are not touched), run in this folder:"
  Write-Host "    `$env:TW4A_LOCAL_URL='$LocalUrl'; `$env:TW4A_LOCAL_DB_CONTAINER='$DbContainer'; `$env:TW4A_LOCAL_JWT_SECRET='<local stack JWT secret>'; `$env:TW4_VALIDATION_KEY_FILE='$KeyFile'"
  Write-Host "    npx tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/stage-bc.ts cleanup --evidence-file <NEW file>"
}

function Get-LastJson($Result) {
  $line = @($Result.Out | Where-Object { ([string]$_).TrimStart().StartsWith("{") }) | Select-Object -Last 1
  if (-not $line) { return $null }
  try { return ($line | ConvertFrom-Json) } catch { return $null }
}

$exitCode = 2
$secretPlain = $null
$einPlain = $null
$seeded = $false
$handled = $false
$ranStage = $false          # true once the harness exited 0/1 for the stage run: Twilio calls may have been made
$cleanupDone = $false
$studio = $null
$LocalEnv = @{}
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$KeyFile = Join-Path $env:TEMP "tw4-stage-b-$stamp.key"
$tempBusiness = $null
$prefix = if ($DryRun) { "selftest-stage-b" } else { "tw4-stage-b" }
$reportDir = Join-Path $env:LOCALAPPDATA "tw4-validation\reports"
$reportPath = Join-Path $reportDir "$prefix-$stamp.json"
$evidencePath = Join-Path $reportDir "$prefix-$stamp-evidence.json"
try {
  Write-Host ""
  if ($UseDryRunDefaults) { Write-Host "DRY RUN (self-test): synthetic values, FAKE adapter, local database only. No prompts, no network, no Twilio contact." -ForegroundColor Cyan }
  elseif ($DryRun) { Write-Host "DRY RUN, INTERACTIVE (self-test of the prompts): synthetic values, FAKE adapter, local database only. No Twilio contact." -ForegroundColor Cyan }
  else {
    Write-Host "TW-4 Stage B: REAL Twilio WRITES (draft resources S1-S10 only; nothing submitted for review; no brand; no fee)." -ForegroundColor Red
    Write-Host "Run this only after the owner has authorized Stage B in writing. Credentials are typed here, kept in this process only, and cleared at the end."
  }

  Write-Step "1/7 Checks"
  if (-not (Test-Path (Join-Path $RepoRoot "node_modules"))) { throw "REFUSED (exit code 2): node_modules is missing under $RepoRoot; run npm install there first." }
  if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) { throw "REFUSED (exit code 2): Node.js (npx) was not found on PATH." }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "REFUSED (exit code 2): Docker was not found; the LOCAL Supabase stack is required." }
  if ($AuthMinutes -lt 1 -or $AuthMinutes -gt 120) { throw "REFUSED (exit code 2): -AuthMinutes must be between 1 and 120." }
  if ($DbContainer -cne "supabase_db_danceflow-e2e-qa" -or $AuthContainer -cne "supabase_auth_danceflow-e2e-qa") { throw "REFUSED (exit code 2): the containers must be the local QA Supabase stack (supabase_db_danceflow-e2e-qa / supabase_auth_danceflow-e2e-qa); no other database is allowed." }
  if ($env:DOCKER_HOST) { throw "REFUSED (exit code 2): DOCKER_HOST is set; a remote docker daemon is not allowed." }
  # The context must point at a LOCAL engine (named pipe / unix socket). Docker Desktop's local engine is the context "desktop-linux", so the endpoint is checked, not the name.
  $dockerEndpoint = ((docker context inspect --format '{{.Endpoints.docker.Host}}') -join "").Trim()
  if (-not ($dockerEndpoint.StartsWith("npipe:////./pipe/") -or $dockerEndpoint.StartsWith("unix:///"))) { throw "REFUSED (exit code 2): the active docker context points at a non-local engine ($dockerEndpoint); switch to the local engine first." }
  $uri = [uri]$LocalUrl
  if (@("127.0.0.1", "localhost", "::1", "[::1]") -notcontains $uri.Host) { throw "REFUSED (exit code 2): -LocalUrl must be a loopback address (shared DEV/PROD are never used)." }
  $running = @(docker ps --format '{{.Names}}')
  foreach ($c in @($DbContainer, $AuthContainer)) { if ($running -notcontains $c) { throw "REFUSED (exit code 2): Docker container '$c' is not running. Start the local QA Supabase stack first." } }
  $jwtLine = @(docker inspect $AuthContainer --format '{{range .Config.Env}}{{println .}}{{end}}') | Where-Object { $_ -like 'GOTRUE_JWT_SECRET=*' } | Select-Object -First 1
  if (-not $jwtLine) { throw "REFUSED (exit code 2): could not read the local stack's JWT secret from '$AuthContainer'." }
  $LocalEnv = @{
    TW4A_LOCAL_URL = $LocalUrl
    TW4A_LOCAL_JWT_SECRET = ([string]$jwtLine -replace '^GOTRUE_JWT_SECRET=', '')
    TW4A_LOCAL_DB_CONTAINER = $DbContainer
    TW4_VALIDATION_KEY_FILE = $KeyFile
  }
  if ($DryRun) { $LocalEnv["TW4_ISV_FAKE"] = "on" }   # dry run only: marks the harness as the fake-adapter self-test (also enables its test seams)
  Write-Host "  Local stack OK ($LocalUrl, containers running). Shared DEV/PROD cannot be reached by this launcher."

  Write-Step "2/7 Inputs"
  $accountSid = Read-Validated -Prompt "Account SID (AC...)" -TestVar "TW4_LAUNCHER_TEST_ACCOUNT" -DryDefault $Dry.Account -Check { param($v) Test-Sid $v "AC" "The Account SID" }
  $keySid = Read-Validated -Prompt "Standard API key SID (SK...)" -TestVar "TW4_LAUNCHER_TEST_KEY_SID" -DryDefault $Dry.KeySid -Check { param($v) Test-Sid $v "SK" "The API key SID" }
  $secretPlain = Read-Validated -Prompt "API key secret (hidden)" -TestVar "TW4_LAUNCHER_TEST_KEY_SECRET" -DryDefault $Dry.Secret -Secret -Check {
    param($v)
    if ($v.Length -eq 0) { return "The secret is empty (nothing was typed and the clipboard held no text)." }
    if ($v.Length -ne 32) { return "The secret has $($v.Length) characters; Twilio API key secrets have 32. Part of it may be missing or extra text was pasted." }
    if ($v -notmatch '^[A-Za-z0-9]{32}$') { return "The secret contains characters other than letters and digits." }
    return $null
  }
  if ($accountSid -eq $keySid) { throw "REFUSED (exit code 2): the Account SID and the API key SID are the same value." }
  $email = Read-Validated -Prompt "Compliance mailbox (the address Twilio will contact)" -TestVar "TW4_LAUNCHER_TEST_EMAIL" -DryDefault $Dry.Email -Check {
    param($v)
    if ($v -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { return "That is not a valid email address." }
    return $null
  }
  if ($UseDryRunDefaults) { $mailboxConfirm = "CONFIRMED" } else {
    $mailboxConfirm = Read-LineInput -Prompt "Type CONFIRMED to state that $email exists and is monitored"
    if ($null -eq $mailboxConfirm) { throw "Cancelled by you (Esc); nothing was sent." }
  }
  if ($mailboxConfirm -cne "CONFIRMED") { throw "REFUSED (exit code 2): the mailbox was not confirmed as existing and monitored (decision D3); nothing was sent." }
  $einPlain = Read-Validated -Prompt "EIN of the studio in the business file (its own EIN, never the ISV's; hidden)" -TestVar "TW4_LAUNCHER_TEST_EIN" -DryDefault $Dry.Ein -Secret -NoClipboardTrack -Check {
    param($v)
    if ($v -notmatch '^\d{2}-?\d{7}$') { return "The EIN must be 9 digits, for example 12-3456789." }
    return $null
  }
  if (-not $UseDryRunDefaults) { Write-Host "  If you pasted the EIN from the clipboard, clear the clipboard yourself (and Windows clipboard history, Win+V, if it is on)." }
  if ($UseDryRunDefaults) {
    $tempBusiness = Join-Path $env:TEMP "tw4-stage-b-dry-$stamp.json"
    @{ legal_name = "Dry Run Studio LLC"; entity_type = "llc"; industry = "EDUCATION"; website_choice = "danceflow"; website_url = ""; address_line1 = "1 Synthetic Way"; address_line2 = ""; city = "Portland"; region = "OR"; postal_code = "97201"; rep_first_name = "Syn"; rep_last_name = "Thetic"; rep_title = "Owner"; rep_position = "ceo"; rep_email = "owner@example.test"; rep_phone = "(503) 555-0100"; preferred_area_code = "503" } | ConvertTo-Json | Set-Content -LiteralPath $tempBusiness -Encoding ascii
    $BusinessFile = $tempBusiness
    $override = Get-TestInput "TW4_LAUNCHER_TEST_BUSINESS"
    if ($override) { $BusinessFile = $override }
  }
  elseif ([string]::IsNullOrWhiteSpace($BusinessFile)) {
    $BusinessFile = Read-LineInput -Prompt "Path of the business JSON file (copy stage-b-business.template.json and fill it in)"
    if ($null -eq $BusinessFile) { throw "Cancelled by you (Esc); nothing was sent." }
    $BusinessFile = $BusinessFile.Trim('"')
  }
  if ($BusinessFile -match '[&|<>^"%!]' -or $BusinessFile.TrimStart().StartsWith("-")) { throw "REFUSED (exit code 2): the business file path contains characters that are unsafe to pass to a command shim (& | < > ^ a double quote % !) or starts with '-'; move the file to a plain path. Nothing was sent." }
  if (-not $UseDryRunDefaults -and (Test-Path -LiteralPath $BusinessFile)) {
    $repoRootNorm = ((Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path.TrimEnd('\') + '\').ToLowerInvariant()
    $bizNorm = (Resolve-Path -LiteralPath $BusinessFile).Path.ToLowerInvariant()
    if ($bizNorm.StartsWith($repoRootNorm)) { throw "REFUSED (exit code 2): the business file is inside the repository, where it could be committed. Create a private copy outside it with scripts\tw4-validation\new-business-file.ps1 and use that one. Nothing was sent." }
  }
  $businessProblem = Test-BusinessFile $BusinessFile
  if ($businessProblem) { throw "REFUSED (exit code 2): business file: $businessProblem Nothing was sent." }
  $business = Get-Content -LiteralPath $BusinessFile -Raw | ConvertFrom-Json
  Write-Host "  Business file OK: $($business.legal_name), $($business.city), $($business.region)."

  Write-Step "3/7 Review"
  Write-Host ("  Account {0}...{1}   key {2}...{3}   mailbox {4}" -f $accountSid.Substring(0, 2), $accountSid.Substring(30), $keySid.Substring(0, 2), $keySid.Substring(30), $email)
  Write-Host ("  Primary profile {0}   Secondary policy {1}" -f $Ids.PrimaryProfileSid, $Ids.SecondaryPolicy)
  if ($DryRun) { Write-Host "  Self-test: the FAKE adapter stands in for Twilio; nothing is sent anywhere." }
  else { Write-Host "  Will create (REAL mode): a draft Customer Profile, EndUsers, Address, SupportingDocument, assignments and a profile evaluation. Nothing is submitted for review." }
  if ($UseDryRunDefaults) { $go = "y" } else { $go = Read-Host "Seed the LOCAL test studio and continue? (y/N)" }
  if ($go -notmatch '^(y|yes)$') { throw "Cancelled by you; nothing was sent." }

  Write-Step "4/7 Seed the local test studio"
  $seedEnv = $LocalEnv.Clone(); $seedEnv["TW4_VALIDATION_EIN"] = $einPlain
  $seed = Invoke-Harness @("seed", "--business", $BusinessFile) $seedEnv
  $seedJson = Get-LastJson $seed
  # The harness writes its marker file BEFORE it finishes seeding: if it exists, local state exists even if the seed then failed.
  if (Test-Path -LiteralPath "$KeyFile.studio") { $seeded = $true; $studio = (Get-Content -LiteralPath "$KeyFile.studio" -Raw).Trim() }
  if ($seed.Code -ne 0 -or -not (Get-Prop $seedJson "studio")) { throw "REFUSED (exit code 2): seeding the local test studio failed (see the message above). Nothing was sent to Twilio." }
  $seeded = $true; $studio = [string](Get-Prop $seedJson "studio")
  if ((Get-TestInput "TW4_LAUNCHER_TEST_FAIL_AFTER_SEED") -eq "1") { throw "SELF-TEST: simulated failure after seeding." }
  Write-Host "  Local test studio $studio seeded (EIN stored encrypted, last 4: $(Get-Prop $seedJson 'einLast4'))."
  $einPlain = $null

  $realEnv = $LocalEnv.Clone()
  $realEnv["NODE_ENV"] = "production"; $realEnv["VERCEL_ENV"] = "production"; $realEnv["TW4_ISV_REAL_CALLS"] = "on"; $realEnv["TW4_ISV_MOCK_BRAND"] = "on"
  $realEnv["TWILIO_ACCOUNT_SID"] = $accountSid; $realEnv["TWILIO_ISV_API_KEY_SID"] = $keySid; $realEnv["TWILIO_ISV_API_KEY_SECRET"] = $secretPlain
  $realEnv["TWILIO_ISV_PRIMARY_PROFILE_SID"] = $Ids.PrimaryProfileSid; $realEnv["TWILIO_ISV_PRIMARY_POLICY_SID"] = $Ids.PrimaryPolicySid
  $realEnv["TWILIO_ISV_SECONDARY_POLICY_SID"] = $Ids.SecondaryPolicy; $realEnv["TWILIO_ISV_A2P_POLICY_SID"] = $Ids.A2pPolicy
  $realEnv["TWILIO_ISV_COMPLIANCE_EMAIL"] = $email
  $realEnv["TWILIO_AUTH_TOKEN"] = ""   # the account auth token is never used by this launcher or the harness

  Write-Step "5/7 Authorization"
  if ($DryRun) {
    # The harness CLI must refuse the retired real mode before any command runs: exit 2, NO token, nothing sent. (This replaces the old check that the real
    # authorization refused a non-interactive caller; real mode can no longer reach the authorization at all.)
    $probe = Invoke-Harness @("authorize-b", "--adapter", "real", "--minutes", "5") $realEnv -ClosedStdin -CaptureStderr
    if ($probe.Code -ne 2 -or (Get-LastJson $probe)) { throw "SELF-TEST FAILED: the harness did not refuse the retired real mode (exit $($probe.Code))." }
    $probeErr = ($probe.Err -replace '\s+', ' ')
    if ($probeErr -notlike "*is retired*" -or $probeErr -notlike "*Nothing was sent to Twilio*") { throw "SELF-TEST FAILED: the harness refused the real mode, but not with the retirement explanation." }
    Write-Host "  Check passed: the harness refuses the retired real mode and issues no authorization (exit 2, no token, nothing sent)."
    $runArgs = @("run", "--stages", "B", "--confirm-studio", $studio, "--out", $reportPath)
    $runEnv = $LocalEnv.Clone(); $runEnv["TW4_ISV_FAKE"] = "on"; $runEnv["TW4_ISV_MOCK_BRAND"] = "on"
  }
  else {
    Write-Host "  The harness will now ask YOU to type a phrase naming the studio. That typed phrase is the authorization."
    $auth = Invoke-Harness @("authorize-b", "--adapter", "real", "--minutes", [string]$AuthMinutes) $realEnv
    $authJson = Get-LastJson $auth
    if ($auth.Code -ne 0 -or -not (Get-Prop $authJson "stage-b-token") -or -not (Get-Prop $authJson "stage-b-expires")) { throw "REFUSED (exit code 2): Stage B was not authorized (see the message above). Nothing was sent to Twilio." }
    Write-Host "  Authorized for $AuthMinutes minutes."
    $go = Read-Host "Type RUN to make REAL draft-write calls to Twilio now (steps S1-S10 only)"
    if ($go -cne "RUN") { throw "Cancelled by you; nothing was sent." }
    $runArgs = @("run", "--stages", "B", "--adapter", "real", "--confirm-studio", $studio, "--stage-b-token", [string](Get-Prop $authJson "stage-b-token"), "--stage-b-expires", [string](Get-Prop $authJson "stage-b-expires"), "--out", $reportPath)
    $runEnv = $realEnv
  }

  Write-Step "6/7 Stage B run"
  New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
  $run = Invoke-Harness $runArgs $runEnv
  # The harness exits 2 ONLY for a refusal/failure before any stage started. Any other code (1 = unclean end, 130 = Ctrl-C, a kill status) means
  # Twilio calls may have been made, which is the safe way to read an unknown code.
  $exitCode = if ($run.Code -eq 0) { 0 } elseif ($run.Code -eq 2) { 2 } else { 1 }
  $ranStage = ($run.Code -ne 2)
  switch ($exitCode) {
    0 { Write-Host "  Stage B ended cleanly at its step limit (S10). Report: $reportPath" -ForegroundColor Green }
    1 {
      Write-Host "  Stage B did NOT end cleanly, or failed after it had started: Twilio calls MAY have been made. Do not rerun; read the evidence below first." -ForegroundColor Yellow
      if (Test-Path -LiteralPath $reportPath) { Write-Host "  Report: $reportPath" } else { Write-Host "  No report was written." }
    }
    default { Write-Host "  Stage B was refused or failed before running (see above). Nothing was sent to Twilio." -ForegroundColor Yellow }
  }

  Write-Step "7/7 Evidence and cleanup"
  $ev = Invoke-Harness @("evidence") $LocalEnv
  $evJson = $null; $evidenceOk = $false
  # psql's json_agg spans several lines: join them before parsing
  if ($ev.Code -eq 0) {
    try { $evText = ($ev.Out -join "`n").Trim(); if ($evText.StartsWith("[")) { $evJson = @($evText | ConvertFrom-Json | ForEach-Object { $_ }); $evidenceOk = $true } } catch { $evidenceOk = $false }
  }
  if (-not $evidenceOk) {
    $exitCode = [Math]::Max($exitCode, 1)
    Write-Host "  The Twilio resource inventory could NOT be read (see above). The local ledger is kept; no cleanup is offered." -ForegroundColor Yellow
    Write-CleanupHelp
    if ($DryRun) { throw "SELF-TEST FAILED: the evidence could not be read." }
  }
  else {
    if ($evJson.Count -eq 0) { Write-Host "  (the ledger holds no rows: nothing was created at Twilio)" }
    foreach ($row in $evJson) { Write-Host ("  {0,-4} {1,-10} {2}" -f $row.step_key, $row.status, $row.provider_sid) }
  }
  if (-not $evidenceOk) { $doCleanup = "n-skip" }
  elseif ($UseDryRunDefaults) { $doCleanup = "y" }
  else { $doCleanup = Read-Host "Clean up the LOCAL fixtures now? The Twilio draft resources stay; their SIDs are saved to $evidencePath (y/N)" }
  if ($doCleanup -eq "n-skip") { }
  elseif ($doCleanup -match '^(y|yes)$') {
    $cleanArgs = @("cleanup", "--evidence-file", $evidencePath)
    $clean = Invoke-Harness $cleanArgs $LocalEnv
    $cleanJson = Get-LastJson $clean
    if ($clean.Code -ne 0 -or -not (Get-Prop $cleanJson "cleaned")) {
      $exitCode = [Math]::Max($exitCode, 1)
      Write-Host "  Cleanup did not complete (see above); the local studio and key were kept." -ForegroundColor Yellow
      Write-CleanupHelp
    }
    else { $cleanupDone = $true; Write-Host "  Local fixtures removed. Evidence (Twilio SIDs): $evidencePath" }
  }
  else {
    Write-Host "  Local studio kept."
    Write-CleanupHelp
  }
}
catch {
  $handled = $true
  Write-Host ""
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  if ($ranStage) {
    # the stage had started: Twilio calls may have been made, so this is NOT "nothing was sent" (exit 1, not 2)
    $exitCode = 1
    if ($DryRun) { Write-Host "The self-test had already run its (fake) stage; no Twilio call was possible." -ForegroundColor Yellow }
    else { Write-Host "Stage B had already started: Twilio writes MAY have occurred. Their SIDs are in the local ledger / evidence file; do not delete the key file ($KeyFile) before saving the evidence." -ForegroundColor Yellow }
  }
  else { $exitCode = 2 }
  if ($seeded -and -not $cleanupDone) {
    if ($DryRun) {
      # leave no state behind after a failed self-test
      try { [void](Invoke-Harness @("cleanup", "--evidence-file", $evidencePath) $LocalEnv) } catch { Write-Host "  (best-effort cleanup of the dry-run fixtures failed)" -ForegroundColor Yellow }
    }
    else {
      Write-Host "A LOCAL test studio ($studio) still exists." -ForegroundColor Yellow
      if (-not $ranStage) { Write-Host "No Twilio call was made." }
      Write-CleanupHelp
    }
  }
}
finally {
  if (-not $handled -and $seeded -and -not $cleanupDone -and -not $DryRun) {
    # reached by Ctrl-C (the catch block is skipped): tell the operator what may exist
    Write-Host ""
    Write-Host "Interrupted. A LOCAL test studio ($studio) may exist." -ForegroundColor Yellow
    if ($ranStage) { Write-Host "Stage B had already started: Twilio writes MAY have occurred; their SIDs are in the local ledger. Do not delete the key file ($KeyFile) before saving the evidence." -ForegroundColor Yellow }
    Write-CleanupHelp
  }
  if ($secretPlain) { Clear-ClipboardIfItHolds $secretPlain }
  $secretPlain = $null
  $einPlain = $null
  $realEnv = $null; $seedEnv = $null; $runEnv = $null
  $script:ClipboardTextUsed = $null
  if ($tempBusiness -and (Test-Path -LiteralPath $tempBusiness)) { Remove-Item -LiteralPath $tempBusiness -Force -ErrorAction SilentlyContinue }
  foreach ($name in @("TWILIO_ACCOUNT_SID", "TWILIO_ISV_API_KEY_SID", "TWILIO_ISV_API_KEY_SECRET", "TWILIO_AUTH_TOKEN", "TW4_VALIDATION_EIN")) { [Environment]::SetEnvironmentVariable($name, $null, "Process") }
  [GC]::Collect()
  Write-Host "Credentials cleared from this process."
  if (-not $DryRun) { Write-Host "Reminder: revoke the temporary Standard API key in the Twilio Console when you are done." }
}
exit $exitCode
