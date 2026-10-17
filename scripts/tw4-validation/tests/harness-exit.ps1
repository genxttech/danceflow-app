$ErrorActionPreference = "Continue"
# Portable paths: everything is relative to this file; scratch output goes to %TEMP%\tw4-launcher-tests.
$here = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sp = Join-Path $env:TEMP "tw4-launcher-tests"; New-Item -ItemType Directory -Force $sp | Out-Null
$hereFwd = $here -replace '\\', '/'
$spFwd = $sp -replace '\\', '/'
Set-Location $repo
$jwt = ((docker inspect supabase_auth_danceflow-e2e-qa --format '{{range .Config.Env}}{{println .}}{{end}}') | Where-Object { $_ -like 'GOTRUE_JWT_SECRET=*' }) -replace '^GOTRUE_JWT_SECRET=',''
$key = Join-Path $env:TEMP "tw4-harness-exit.key"
$base = @{ TW4A_LOCAL_URL="http://127.0.0.1:55321"; TW4A_LOCAL_JWT_SECRET=$jwt; TW4A_LOCAL_DB_CONTAINER="supabase_db_danceflow-e2e-qa"; TW4_VALIDATION_KEY_FILE=$key; TW4_ISV_FAKE="on"; TW4_ISV_MOCK_BRAND="on"; TW4_VALIDATION_EIN="11-2223333" }
foreach ($k in $base.Keys) { [Environment]::SetEnvironmentVariable($k, $base[$k], "Process") }
$biz = Join-Path $sp "business.json"
'{"legal_name":"Harness Test LLC","entity_type":"llc","industry":"EDUCATION","website_choice":"danceflow","website_url":"","address_line1":"1 Synthetic Way","address_line2":"","city":"Portland","region":"OR","postal_code":"97201","rep_first_name":"Syn","rep_last_name":"Thetic","rep_title":"Owner","rep_position":"ceo","rep_email":"owner@example.test","rep_phone":"(503) 555-0100","preferred_area_code":"503"}' | Set-Content -LiteralPath $biz -Encoding ascii
function Hx([string[]]$a) { $o = & npx.cmd tsx --tsconfig scripts/tw4-validation/tsconfig.json scripts/tw4-validation/stage-bc.ts @a 2>&1 | Out-String; [pscustomobject]@{ Code = $LASTEXITCODE; Out = $o } }
function Db([string]$sql) { (docker exec supabase_db_danceflow-e2e-qa psql -U postgres -At -c $sql) -join "" }
$r = New-Object System.Collections.Generic.List[string]
function Check([string]$n, [bool]$ok, [string]$detail = "") { $script:r.Add(("{0,-70} {1} {2}" -f $n, $(if ($ok) { "PASS" } else { "FAIL" }), $detail)) }

$seed = Hx @("seed", "--business", $biz); $st = ($seed.Out | Select-String '"studio":"([^"]+)"').Matches.Groups[1].Value
Check "seed ok" ($seed.Code -eq 0 -and $st) $st
$c = Hx @("run", "--stages", "C", "--confirm-studio", $st)
Check "harness: stage C without authorization = pre-run refusal = exit 2" ($c.Code -eq 2 -and $c.Out -like "*own authorization*") "exit $($c.Code)"
$wrong = Hx @("run", "--stages", "B", "--confirm-studio", "7a1d0000-0000-4000-8000-000000000000")
Check "harness: wrong typed studio confirmation = exit 2" ($wrong.Code -eq 2) "exit $($wrong.Code)"
$cl0 = Hx @("cleanup")   # no rows yet: allowed without evidence
Check "(sanity) cleanup with an EMPTY ledger needs no evidence file" ($cl0.Code -eq 0 -and $cl0.Out -like '*"cleaned":true*') "exit $($cl0.Code)"
# the cleanup above removed the studio: seed again for the ledger tests
$seed2 = Hx @("seed", "--business", $biz); $st = ($seed2.Out | Select-String '"studio":"([^"]+)"').Matches.Groups[1].Value
$b = Hx @("run", "--stages", "B", "--confirm-studio", $st)
Check "harness: clean stage B (fake) = exit 0" ($b.Code -eq 0) "exit $($b.Code)"
# make the ledger rows lose their SIDs, as after an unknown outcome (the ledger may refuse; then report that honestly)
$upd = docker exec supabase_db_danceflow-e2e-qa psql -U postgres -At -c "update public.studio_sms_provisioning_steps set provider_sid = null where studio_id = '$st'" 2>&1 | Out-String
$withSid = [int](Db "select count(*) from public.studio_sms_provisioning_steps where studio_id = '$st' and provider_sid is not null")
$rows = [int](Db "select count(*) from public.studio_sms_provisioning_steps where studio_id = '$st'")
Check "(setup) ledger rows now: $rows total, $withSid with a SID" ($rows -gt 0) ($upd.Trim().Split("`n")[0])
$cl1 = Hx @("cleanup")
Check "harness: cleanup REFUSED without --evidence-file while ANY ledger row exists" ($cl1.Code -eq 2 -and $cl1.Out -like "*Cleanup refused*") "exit $($cl1.Code)"
Check "harness: nothing was deleted by the refused cleanup" ([int](Db "select count(*) from public.studio_sms_provisioning_steps where studio_id = '$st'") -eq $rows)
$ev = Join-Path $env:TEMP "tw4-harness-exit-evidence.json"; Remove-Item $ev -ErrorAction SilentlyContinue
$cl2 = Hx @("cleanup", "--evidence-file", $ev)
Check "harness: cleanup with a NEW evidence file saves it first, then cleans" ($cl2.Code -eq 0 -and (Test-Path $ev)) "exit $($cl2.Code)"
$evRows = @(Get-Content $ev -Raw | ConvertFrom-Json | ForEach-Object { $_ })
Check "harness: evidence file holds the friendly names even without SIDs" ($evRows.Count -eq $rows -and @($evRows | Where-Object { $_.friendly_name }).Count -eq $rows) "$($evRows.Count) rows"
Remove-Item $ev -Force -ErrorAction SilentlyContinue
$pin = & { $env:TW4A_LOCAL_DB_CONTAINER = "supabase_db_other"; $x = Hx @("evidence"); $env:TW4A_LOCAL_DB_CONTAINER = "supabase_db_danceflow-e2e-qa"; $x }
Check "harness: a different DB container name is refused (exit 2)" ($pin.Code -eq 2 -and $pin.Out -like "*must be the local QA database container*") "exit $($pin.Code)"
$dh = & { $env:DOCKER_HOST = "tcp://10.0.0.5:2375"; $x = Hx @("evidence"); Remove-Item Env:DOCKER_HOST; $x }
Check "harness: DOCKER_HOST (remote daemon) is refused (exit 2)" ($dh.Code -eq 2 -and $dh.Out -like "*DOCKER_HOST is set*") "exit $($dh.Code)"
foreach ($k in $base.Keys) { [Environment]::SetEnvironmentVariable($k, $null, "Process") }
"leftover studios: " + (Db "select count(*) from public.studios where id::text like '7a1d0000-%'")
$r
