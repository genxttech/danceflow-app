# Website Embeds: bounded DEV migration procedure

Target: DEV only (Supabase project `epdrtzcydvnoidwrepqz`). Nothing here touches PROD, deploys, or promotes. Every hosted-SQL step goes through
`bash C:/Users/mcurt/danceflow-ops/sb.sh`, which checks the linked project, requires the exact SHA-256 for apply modes, rejects CR line endings,
runs read modes in a read-only transaction, and logs every run to `danceflow-ops/log/ops.log`. A wrong hash stops before any SQL runs (tested).

## Files (SHA-256)

| File | Role | SHA-256 |
|---|---|---|
| `src/lib/supabase/migrations/20270216090000_website_embed_settings.sql` | the migration | `2ddcb78b988b91c955b0dd3cc1cb7891f0343262c68965f3b3b9d50031b53991` |
| `src/lib/supabase/migrations/rollback/20270216090000_website_embed_settings_rollback.sql` | rollback | `d32a7bca5da22a138600f8421cf5536af9d1d776145ad4dc7e72cbfafa420264` |
| `scripts/qa/embeds/postflight.sql` | read-only verification | `9b07e74d5e019a81f2d2309c070e3afd1f930d5a3896c961f986d047f4b2be05` |
| `scripts/qa/embeds/dev/fixtures.sql` | fictional fixtures | `3b1e446c5f45ea9ecaedf7b6775df62d53ff27e3ce2f8ba2e399a61d67c49f17` |
| `scripts/qa/embeds/dev/verify-settings.sql` | behavior check, always rolled back | `4bd021747abf30ae186ef0e93e4c0b62a72cb49691065b7ce00bbdc8c5886057` |
| `scripts/qa/embeds/dev/fixtures-cleanup.sql` | removes exactly the fixtures | `bfa3bad41aead12107f1fb862954788fc0c61e92d2fbd7678a8edf91f1b9f1f9` |

(If any file changes, its hash changes and the approval no longer matches: `sb.sh` refuses.)

## Steps

0. **Drift check (read-only).** Re-run the DEV preflight: the migration's table and five functions must still be absent, and the dependency tables and
   columns present. Stop if anything differs.
1. **Apply the migration:** `sb.sh dev-apply <migration> 2ddcb78b…`. Expect exit 0.
2. **Postflight (read-only):** `sb.sh dev-read scripts/qa/embeds/postflight.sql` must return `"all_ok": true`.
3. **Apply the fictional fixtures:** `sb.sh dev-apply scripts/qa/embeds/dev/fixtures.sql 3b1e446c…`. Expect exit 0. Creates two fictional studios
   (`embed-qa-fictional-a` and `-b`, ids `e3b00000-…-0001`/`-0002`), a four-occurrence series with a description and $20, a $25 single class, and events
   (public, multi-day, private, draft, other studio). No users, no payment accounts, no client data; dates are relative to the day it runs.
4. **Behavior check:** `sb.sh dev-apply scripts/qa/embeds/dev/verify-settings.sql 4bd02174…`. Expect exit 0 and `DEV EMBED SETTINGS VERIFY PASS`. It checks
   defaults, opt-in description and price, the kill switch, studio isolation and non-public studios, inside a transaction that always rolls back.

## Stop conditions

- Any non-zero exit, or `all_ok` not `true`: stop at once, run nothing further, report the exact output.
- Migration step fails or postflight is not ok: run the rollback (`sb.sh dev-apply <rollback> d32a7bca…`; repeatable, deletes any stored settings), then re-run the
  drift check to confirm DEV is back to "objects absent". The migration is also repeatable, so a re-apply after fixing the cause is safe.
- Fixture or behavior-check failure: run `fixtures-cleanup.sql`; keep the migration only if the postflight was ok.
- DEV migration history is stale (latest `20261014090519`), and `sb.sh` does not write to it; do not "repair" it as part of this.

## Not covered by this DEV operation

- **No application deployment.** The embed pages are not served from DEV by this operation (main builds on Vercel are cancelled by the ignored-build step, and no
  workflow deploys or promotes). So builder, public embed and registration handoff cannot be exercised against DEV until a separately authorized app deployment
  pointing at DEV exists; the DB-level behavior is covered by steps 2 and 4, and the full browser suite by `scripts/qa/embeds/acceptance.mjs` on the disposable stack.
- No test accounts are created (the owner login needed for the builder and kill-switch UI would be created at that later gate).
- **PROD** needs its own owner approval of the same migration hash, then the same postflight through `sb.sh prod-read`, then the app release.

## Tested locally (disposable database)

Migration, fixtures (twice), behavior check, postflight (`all_ok`), cleanup (twice), rollback and re-apply: all passed; the behavior check leaves nothing behind.
