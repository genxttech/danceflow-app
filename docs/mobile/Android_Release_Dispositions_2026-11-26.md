# Android release: engineering follow-up to the owner dispositions of 2026-11-26 (A3, H4, H5, H12, H13, H14)

Written 2026-11-26 against main `b758fe072`. Dispositions: `docs/ops/APPS_Owner_Dispositions_2026-11-26.md` (held by the APPS coordinator; not on main when this was written). Nothing here rotates a key, changes a provider, uploads, deploys or spends money. The factual check of the Play drafts (H10) is `Google_Play_Internal_Testing.md` section 12.

## A3. Firebase Admin key rotation (key id `6335e6cbc1...`)

### What is known

- Service account `firebase-adminsdk-fbsvc` of project `danceflow-mobile-dev`. A key file sat in `Downloads` (file date 2026-06-26); the local copy was overwritten and deleted on 2026-11-15 without being opened (`APPS_STATUS.md` addenda). **Deleting the file did not revoke the key.** No rotation is recorded.
- Push delivery through Expo succeeded on 2026-11-14 (Student, DEV). Expo therefore holds a working FCM v1 credential. **Which key id Expo holds is unknown.**

### Dependency inventory

| Possible consumer | Uses a Firebase service-account key? | Evidence |
|---|---|---|
| Expo FCM v1 credential, Student EAS project `122aaca5-d8eb-4ad9-84bc-f05c0e3bb8d1` (owner `idanceflow`) | **Yes, some key**; whether it is `6335e6cbc1` is **UNKNOWN** | DEV delivery 2026-11-14 |
| Business app | No: no EAS project id, no push credential | `mobile/business/app.json` |
| Web/server code (main `b758fe072`, `release/website-embeds` `49dbaee1b`, `e84ed0f3`) | No: no `firebase-admin`, `GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_*` or `FCM_*` reference outside docs and the Gradle file check; the server sends through `exp.host` without an access token | `git grep`, `src/lib/notifications/expoPush.ts` |
| GitHub Actions workflows | No Firebase or Google secret referenced | `secrets.*` names in `.github` |
| Vercel environment variables | **UNVERIFIED** (not read); the code has no consumer | check names only |
| `google-services.json` (client config) | No: a separate client API key, not affected by this rotation | file structure |
| Built AABs | No service-account JSON | `scan-aab-secrets.js` on the real-key AABs |
| This PC | No file named `*adminsdk*` under Downloads, Desktop, Documents, `df-credentials`, `C:\dfr`, `danceflow-ops` (depth 4, 2026-11-26) | filename search only |
| Backups, cloud sync, other machines, gcloud default credentials | **Cannot be verified** | this is why rotation is warranted |

### Sequence (owner performs every credential step; engineering never receives the file)

| # | Step | Who | Done when |
|---|---|---|---|
| 0 | Read only. Google Cloud console, IAM, Service accounts, `firebase-adminsdk-fbsvc`, Keys: list key ids, creation dates and creator; check usage metrics if shown. Expo, the Student project, Credentials, Android, FCM V1: note the key id and service-account email | owner (screenshots without key material) | we know which key Expo holds and whether any other key exists |
| 1 | Create a replacement. Recommended: a **new dedicated service account** limited to sending FCM messages (role "Firebase Cloud Messaging API Admin"; confirm the exact role name in the console) instead of another broad Admin SDK key | owner | new key id recorded |
| 2 | Upload it to Expo (Student project, FCM V1). Delete the downloaded JSON at once and empty the Recycle Bin. Never paste it into chat, a ticket or a repo | owner | Expo shows the new key id |
| 3 | **Disable** (do not delete) the old key in Google Cloud. Disabling is reversible | owner | key shows disabled |
| 4 | Wait at least 1 hour (cached access tokens), then run the DEV push test (`Android_Push_Firebase_Setup.md`, DEV push-delivery test): Expo ticket `ok`, receipt `ok`, notification shown | engineering | PASS recorded with time. A pass with the old key disabled proves the replacement is in use |
| 5 | Delete the old key; record ids and dates in `APPS_STATUS.md` | owner, then engineering records | key absent from the list |

If step 4 fails: re-enable the old key (possible until step 5), check which key Expo holds, and repeat. If step 0 shows Expo already holds a different key, the old key has no known consumer: disable it, run step 4, delete. Step 4 needs a DEV build with the DEV `google-services.json`, a disposable stack and an emulator (heavy queue).

## H4. Play uploads

On hold. Nothing was uploaded by engineering.

## H5. Separate production Firebase project (design; required before closed or production release, not for internal testing)

| Area | Design |
|---|---|
| Project | New project (for example `danceflow-mobile-prod`) in the account that owns Play and Expo; Analytics off. DEV project stays for internal testing |
| Apps | Register `com.idanceflow.student` and `com.idanceflow.business`; one `google-services.json`, stored outside every repo (`df-credentials\firebase-prod\`) |
| Sending credential | A dedicated service account with only the FCM sending role; its key uploaded to Expo per EAS project; never in the web app, CI or a developer folder |
| Business | Needs `eas init` before it can mint a push token (H6 keeps push out of the first Business internal build) |
| Build tooling (engineering follow-up) | `Build-ReleaseAab.ps1` copies the Firebase file only for Student: add the Business path (`GOOGLE_SERVICES_JSON` before prebuild); add an expected Firebase `project_id` to the expected-value files and check it in the AAB, so a DEV file cannot ship in a wider release (and a PROD file cannot enter a QA build) |
| Cutover | Ships in a new version code. Push registrations belong to the sender project, so devices must re-register after updating; the server should disable tokens that Expo reports `DeviceNotRegistered` (check this before cutover). Old builds keep DEV delivery only while the DEV credential is attached to the same EAS project, and **one EAS project holds one FCM credential**: switching it stops delivery to old builds, so cut over while the tester group is small |
| Crash reporting (H9) | Crashlytics goes in the same PROD project, after privacy and Data safety review; not activated by this design |
| Rollback | Re-upload the DEV-project credential to Expo and ship a build with the DEV file |

The Expo behaviour in the cutover row is design reasoning, **not verified**: confirm on a disposable build before relying on it.

## H12. Android 12 image for local QA

Queued as its own FIFO ticket (`*-android-release-h12-api31.txt`) with a self-releasing script: `system-images;android-31;google_apis;x86_64` through `sdkmanager` from Google's SDK repository (about 1 GB download, owner-approved), at least 15 GB free required (about 40 GB free when queued), no licence is accepted by the script, `sdkmanager`'s archive checksum plus recorded SHA-256 of the installed images, AVD `df-api31`, one headless boot. Evidence: `C:\dfr-out\android12-image\`. **Result: pending.** The first attempt (20:42-20:43Z) failed before downloading: this PC's `sdkmanager.bat` is now a wrapper over the Android CLI, and the unquoted `;` package name was split into four unknown packages. The lock was released. The script now passes the slash form `system-images/android-31/google_apis/x86_64` (listed by the repository as revision 14.0.0) and was re-queued at the back. The wrapper asks for no licence interactively; the installed `android-35` image uses `android-sdk-license`, already accepted on this PC, and the script records which licence the new image names. App checks on Android 12 are not part of this job and remain UNTESTED.

## H13. One real-device pass without owner manual testing (proposal)

| Option | What it proves | Needs | Cost / risk |
|---|---|---|---|
| **A. One authorized tester** (recommended) | Real phone, production-valued Play build: magic link, QR, offline, settings links; Business 12-step script if a test staff account exists; can include a 10-minute TalkBack walk (H11) | The coordinator or owner names one non-owner person with an Android phone; their address is added to the internal tester list (a Console change, needs authorization); Business needs the H3 test account | No charge |
| B. Play pre-launch report | Automated crawl on Google's devices after an upload | An upload (held by H4) and reviewer sign-in | Whether it runs for the internal track is **UNVERIFIED** |
| C. Firebase Test Lab | Automated run on physical devices | Google sign-in, terms, quota; a build pointed at a reachable non-production backend | Current free quota **UNVERIFIED**; not recommended now |

Plan for A: engineering sends the coordinator the forwardable message (`Student_Internal_Tester_Smoke.md` part 1), the tester reports device model, Android version, app version and pass or fail per step, and engineering reads the server-side signals of part 2. Student version code 2 on the internal track is enough to start; it does not wait for a new build.

## H14. Local staging cleanup

Confirmed before deleting (2026-11-26): the three release AABs in `C:\dfr-out\release\` hash to their recorded values (`f67a39a5...`, `b4ca4725...`, `48cfd4a4...`); the Business staging copy of its AAB equals the retained one; no links or junctions in the folders; the Business JS source maps, manifest-merger report and build metadata, the CMake logs and the Kotlin daemon logs were copied to `C:\dfr-out\release\retained\` and `C:\dfr-out\release\logs\` and verified. `C:\dfr\rel-student` was already absent, so **Student source maps for the uploaded builds are not retained here** (a rebuild of the same commit would be needed to symbolicate a JavaScript stack, and is not guaranteed to be byte-identical).

| Deleted | Size |
|---|---|
| `C:\dfr\rel-business` (worktree at `42e31612d1d1`, clean; its worktree record too) | about 3.8 GB |
| `C:\dfr\tmp-rel-student-f5f31103` | about 36 MB |
| `C:\dfr\tmp-rel-student-4564c0b2` | about 36 MB |
| `C:\dfr\tmp-rel-business-42e31612` | about 26 MB |

Kept: every AAB, the check evidence, logs, all `C:\dfr-out` evidence, other sessions' folders and temporary directories. Deletion verified complete; the three AAB hashes were re-checked afterwards (42.0 GB free).
