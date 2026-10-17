# TW-4 launcher and harness tests

These scripts test the PowerShell launchers (`run-stage-a.ps1`, `run-stage-b.ps1`) and the `stage-bc.ts` harness CLI end to end, **without ever contacting Twilio**.
They are not part of `npm test` because they need Windows PowerShell 5.1, Docker Desktop with the local QA Supabase stack, and a real console.

## Prerequisites
- Windows, Windows PowerShell 5.1 (`powershell.exe`), Node with this repo's `node_modules`.
- The local QA Supabase stack running in Docker (containers `supabase_db_danceflow-e2e-qa` and `supabase_auth_danceflow-e2e-qa`) with the TW-4A, TW-4A.1, R1 and R1.1 migrations applied. Nothing in these tests can reach shared DEV or PROD (the harness pins those container names and loopback URLs).
- Nothing else using the console while the interactive suites run: they start minimized PowerShell windows and inject real key events.

## Scripts (run from any folder: `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`)
| Script | What it checks | Time |
|---|---|---|
| `launcher-a-matrix.ps1` | Stage A launcher: dry run, input validation, refusals, test hook inert in real mode | ~1 min |
| `launcher-a-interactive.ps1` | Stage A secret entry through the real prompts: Ctrl+V (clipboard), pasted bursts, bracketed paste, Enter-from-clipboard, Backspace, Esc | ~4 min |
| `launcher-b-matrix.ps1` | Stage B launcher: dry run (22 cases) including refusals, container pin, DOCKER_HOST, failed seed cleanup, unreadable evidence, with a network tripwire | ~6 min |
| `launcher-b-interactive.ps1` | Stage B through the real prompts: mailbox CONFIRMED rule, EIN/email validation, unfilled template, Esc, declining seed/cleanup | ~10 min |
| `harness-exit.ps1` | CLI exit codes (2 = refused before a stage, 1 = after), cleanup refuses without an evidence file, container pin, DOCKER_HOST | ~1 min |
| `inject.ps1`, `netblock.cjs` | helpers: console key-event injector; preload that records and refuses non-loopback network use (`NETBLOCK_LOG` is the log) | |

Set `ENTRY_ONLY="<part of a scenario name>"` to run a single interactive scenario.

## Safety properties of the tests themselves
- The interactive suites replace `Get-Clipboard` / `Set-Clipboard` with fakes in the child console; your real clipboard is never read or changed.
- Only reports named `selftest-*` are deleted; real reports in `%LOCALAPPDATA%\tw4-validation\reports` are left alone.
- Scratch files live in `%TEMP%\tw4-launcher-tests`; the synthetic values used are not credentials.
