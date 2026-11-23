# M14 baseline evidence

- `race_harness_on_m13_bug_2026-11-23.txt`: first run of the race harness on an M13 database. **R1 (erase) is a valid reproduction of P2-A. The "R2" line in that file is withdrawn: it was a false positive** (the purge held the client lock, the hold creator waited, so the delete was correct). See `NSI_M14_Test_Plan.md` section 6.
- `stable_snapshot_experiment_2026-11-23.txt`: a function called from a volatile trigger sees a hold committed during the delete's lock wait for both STABLE and VOLATILE functions; the STABLE-snapshot claim is retracted.
