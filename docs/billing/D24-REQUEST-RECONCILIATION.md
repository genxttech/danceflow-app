# D24 request reconciliation (workstream C, part 2)

Status: research + a pure, tested comparison tool. **No Stripe API call was made.** Sources: docs.stripe.com pages read while writing this, one Stripe support page via search, and this repository. Statements are tagged **[docs]**, **[support page]** (single secondary source) or **[unverified]**.

Premise (owner): request ids collected by the app are **not** automatically an independently verified provider log. They are the app's own claim about what it sent and what Stripe answered. Reconciliation compares that claim with something obtained separately from Stripe.

## 1. Mechanisms for independently getting request logs / ids (TEST sandbox)

| Mechanism | What it gives | Coverage / limits |
|---|---|---|
| **Dashboard Developers > Logs** and **Workbench > Logs** (Workbench replaces the Developers Dashboard for new accounts) | Per-request log: request id, time, method, endpoint, status, API version, IP, source (API vs Dashboard), error type/code/param, "account that the request applied to, which might be the connected account of a Connect platform". Filters: date, status, method, endpoint, resource id, IP, source, account, API version, error fields. [docs `workbench/overview`, `development/dashboard/request-logs`] | **Only mechanism documented to cover everything:** GETs, POSTs, DELETEs, failed requests (4xx/5xx; a restricted key's own log shows its `403 ERR` rows [docs `keys/restricted-api-keys`]), and connected-account scope. Logs are shown per account (and per key via "View request logs" on the API-keys page). Needs a Dashboard user with Administrator or Developer role. **No refresh in real time** ("Refresh logs"). Retention: GET logs 31 days, non-GET 15 months [support page]. **No export or logs API is documented**; a human reads or copies rows. Delay: not documented. |
| **Stripe CLI `stripe logs tail`** | Streams API request logs from a **sandbox in real time**: lines like `[200] POST /v1/customers [req_…]`; `--format JSON`; filters `--filter-account connect_in\|connect_out\|self`, method, path, status, source. [docs `cli/logs/tail`] | Genuinely independent of the app (Stripe's server-side stream, separate CLI login) and includes GETs and failures. **Not retroactive:** only requests made while it is running; a dropped connection loses rows silently; no completeness guarantee is stated; sandbox only. How `Stripe-Account` requests are classified (`connect_in` / `connect_out` / `self`) is not spelled out, so run it **without** an account filter. [unverified: classification] Needs a CLI login by a person with access. Closest thing to a machine-readable independent log. |
| **Events API** `GET /v1/events` (and retrieve), Workbench Events tab, webhooks | Event objects with `request: { id, idempotency_key }` for API-originated changes, `account` for connected-account events, `created`. [docs `api/events`] Retention 30 days. [docs] | **Only state-changing operations that emit events** (e.g. creating/deleting a customer or invoice, account updates). **No events for GETs. No events for rejected requests (403/4xx).** `request` is null for changes not made by an API call. Needs a key with Events read, i.e. another API call set (separate approval, `GET /v1/events` is not in the proof's allow-list) and connected-account events need the connected scope. Useful only as a **partial** cross-check of writes. |
| Dashboard resource pages / Inspector (object -> Logs tab) | Logs for one object. [docs] | Same data as Logs, object-scoped. |
| Request Logs export / logs API | **None found in the docs read.** | Do not assume one exists. |

## 2. Is any non-dashboard mechanism equivalent?

**No.** Not shown:
* Events API: writes only; blind to GETs and to every rejected request, which are exactly the requests the proof's permission negatives (403s) and blocked-request checks care about.
* `stripe logs tail`: covers GETs and failures, but only live, only for a sandbox, with no stated completeness or loss detection, and an unspecified treatment of `Stripe-Account` requests. It is a strong **additional** independent source and should be captured during every supervised run, but it does not replace a dashboard check.

Therefore: **independent Dashboard/Workbench verification is STILL REQUIRED.** Exact limitation: a person must filter the Logs view to the run window (all methods, all statuses, source API, the run's key and connected-account scope) and record or export what it shows, because no documented API or export returns that log. Every reconciliation result prints `independentVerification: "STILL_REQUIRED"` and a CONSISTENT verdict is never presented as proof of completeness.

## 3. What the reconciler detects

`scripts/qa/d24-test-provision/reconcile.ts` (pure; no I/O, no network) compares `SentRequest[]` (parsed from the proof's printed transcript lines, `parseProofTranscript`) with `ProviderEntry[]` from a normalized provider-log file.

Comparison keys, in order: `req_...` request id (primary); method; path (query dropped); HTTP status; `Stripe-Account` scope (masked ids compared by visible prefix/suffix); idempotency key for POSTs (full or the proof's masked `first12…(length)` form); timestamps within `maxSkewMs` (default 120 s); run window = **supplied independently by the operator** (`--window-start`/`--window-end`, required; ISO-8601 UTC with Z or +00:00, start before end, at most 24 h), never derived from the transcript: a truncated transcript would otherwise shrink the window and hide extras.

| Finding | Meaning | Severity |
|---|---|---|
| `missing_in_provider` | app recorded a request id the provider log lacks | fail |
| `extra_in_provider` | provider shows an in-window request the app did not record (also: a request the app BLOCKED before the network appears at the provider) | fail |
| `out_of_window_provider` | provider row outside the operator's window: either a request the app never recorded or a filter wider than attested | **fail** |
| `out_of_window_sent` | transcript entry outside the operator's window | fail |
| `transcript_unparsed` | a numbered transcript line did not parse, or the footer `Calls used: U of hard cap N; blocked before network: B` is missing, malformed, or disagrees (network lines must equal U, BLOCKED lines must be at least B); reported, never skipped | fail |
| `replay_without_original` | a `replayed` transcript line has no already-matched original (same method, path, full idempotency key, different request id); a replay cannot explain, and never absorbs, a provider request | fail |
| `count_mismatch` | per `METHOD path` counts differ (app vs provider, replays excluded) | fail |
| `duplicate_in_provider` / `duplicate_in_sent` | same request id twice | fail |
| `field_mismatch` / `time_skew` | matched id but method, path, status, account scope, idempotency key or time disagree | fail |
| `replay_matched_to_original` | app flagged an idempotent replay and an already-matched original exists (same key, method, path); the provider does not show the replay's own id | info (whether Stripe logs a replay as its own row is **[unverified]**) |
| `error_entry_matched` / `error_entry_not_in_provider` | app saw no response (transport error); provider does / does not show it | warn |
| `provenance_problem` | provider file lacks who/when/filter, or the operator did not attest that the filter covered the whole window, all methods and statuses (fail); source is `events_api_partial` (warn) | fail / warn |

Fixtures in `__tests__/reconcile.test.ts`: matching, missing, extra, duplicate (both sides), out-of-window, replayed idempotent request, failed 4xx (match and status disagreement), field/time mismatches, transport-error entry reached/not reached, blocked-must-be-absent, missing/weak provenance, empty transcript, parsers.

### Provider-log file (our format; the Dashboard has no documented export)
```json
{ "provenance": { "source": "workbench_logs | dashboard_logs | stripe_cli_logs_tail | events_api_partial",
                  "obtainedBy": "name", "obtainedAtUtc": "ISO", "filterDescription": "exact filters used",
                  "coversWholeWindowAllMethodsAllStatuses": true },
  "entries": [ { "requestId": "req_...", "method": "POST", "path": "/v1/customers", "status": 200,
                 "createdUtc": "ISO or epoch", "idempotencyKey": "optional", "account": "acct_... or null" } ] }
```
`source: "app_collected"` is rejected by the parser. A person converts what they see (or the `--format JSON` CLI lines) into this shape; the tool never invents fields. Run: `npx tsx scripts/qa/d24-test-provision/reconcile-cli.ts --transcript <transcript-*.txt> --provider <provider-log.json> --window-start <ISO> --window-end <ISO>`. **Exit codes:** `10` = CONSISTENT_UNVERIFIED (no discrepancy found; independent Dashboard verification STILL REQUIRED; there is deliberately no exit 0), `1` = discrepancies, `2` = usage or input problem. Output always states that consistency is NOT independent verification ().

## 4. What it cannot do (state these in any report that uses it)
* It cannot prove the provider file is complete, unaltered or from the right account; a person's attestation and a screenshot-level look at the Dashboard remain necessary.
* It sees only what the filter showed: requests made by other actors (e.g. the owner clicking in the Dashboard) inside the window show up as `extra_in_provider`; filter by source API and the run's key, and explain any residue by hand.
* GET logs are kept for a shorter time than writes [support page]; reconcile within days, not weeks.
* Retries: the proof transport never retries; the app's Stripe SDK does (`maxNetworkRetries: 2`), so an app-side record can omit retried requests. Reconciling app traffic needs the provider side to be the authority.
* Replay logging and `Stripe-Account` classification in the CLI are [unverified] and are handled conservatively (info/warn, no silent pass).

## 5. Recommended procedure for each supervised proof run
1. Before: person opens Workbench > Logs for the sandbox and notes the time; starts `stripe logs tail --format JSON` writing to a file outside git (separate CLI login, no account filter).
2. Run the proof. 3. After: person filters Workbench Logs to the window (all methods and statuses, source API) and records the rows in the provider-log format (and attaches the tail file as a second source). 4. Run the reconciler per source; any `fail` is a finding. 5. Attach the result and the unresolved limitation list to the proof report; the Dashboard comparison is still marked as a human step.

## 6. Owner-only / person-only actions
Dashboard access and the Logs read-out; deciding the allowed residue of foreign requests; approving any later `GET /v1/events` use (a new key permission and allow-list change in the proof, not part of this PR).
