# Staff API end-to-end QA (local only)

Real GoTrue tokens, over HTTP, through a local Next dev server, against a disposable `iso-qa` stack. Nothing here touches a hosted database.

1. Start a stack: `node scripts/qa/iso-qa.mjs up baseline --name staffhttp`, and keep the printed `TW4A_LOCAL_*` values in your environment.
2. Attach GoTrue behind its Kong: `node scripts/qa/staff-api/attach-gotrue.mjs staffhttp <kong port> "$TW4A_LOCAL_JWT_SECRET"`.
3. Apply any migrations under test, for example `20270214120000_instructor_class_roster_names_rpc.sql`, then `notify pgrst, 'reload schema'`.
4. Start Next with only local values: `NEXT_PUBLIC_SUPABASE_URL` (the stack URL), plus `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` as `anon` and `service_role` JWTs signed with the stack's secret. Run `npx next dev -p 3107` from a worktree with no `.env.local`.
5. Run `STAFF_QA_AUTH_CONTAINER=df-isoqa-staffhttp-auth STAFF_QA_OUT=<file> node scripts/qa/staff-api/http-qa.mjs`. It refuses non-loopback URLs and exits non-zero on any failure. The last case stops and restarts GoTrue to check the outage path.
   For slice 2 (client lookup, client summary, attendance PUT, `timeZone`), also run `STAFF_QA_OUT=<file> node scripts/qa/staff-api/http-qa-slice2.mjs`. It needs every migration above the baseline cutoff applied, not only the roster function. Set `STAFF_QA_APP` if Next runs on another port.
6. Tear down: stop Next, then `docker rm -f df-isoqa-staffhttp-auth` and `node scripts/qa/iso-qa.mjs down --name staffhttp --force`.
