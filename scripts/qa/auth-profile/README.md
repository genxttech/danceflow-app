# iso-qa auth profile helpers

Scripts for stacks started with `node scripts/qa/iso-qa.mjs up <scenario> --auth`. That command adds a real GoTrue and a Mailpit behind the stack's own Kong. The full description is under "Auth profile" in `docs/twilio/TW-4F_Isolated_QA.md`.

| File | What it is |
|---|---|
| `lib.mjs` | `loadStack(file)` refuses anything that isn't a loopback `--auth` stack. `createUser` (GoTrue admin API), `latestAuthLink` (Mailpit) and `psql` |
| `auth-smoke.mjs` | Proves a stack: password grant, the GoTrue JWT accepted by PostgREST as `auth.uid()`, a magic link delivered and redeemed, sign-out-everywhere revoking the session, and a CORS preflight. Exits 0 when all checks pass |
| `business-shell/` | The DanceFlow Business mobile walkthrough (seed, dev-only web proxy, Playwright walk) |

Everything here is for local, disposable stacks only. Keep the JSON files these scripts read and write (keys, test passwords) out of the repo.
