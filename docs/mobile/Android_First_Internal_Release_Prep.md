# First signed AAB of each app into Play internal testing: engineering prep (2026-11-20)

State (from the owner, via the APPS coordinator): the Play organisation account "DanceFlow" is verified; `com.idanceflow.student` and `com.idanceflow.business` already exist in Play Console (unpublished); the internal tester lists are already configured. Nothing below asks the owner to recreate any of that.

Scope of this document: everything engineering can prepare **without** a real signing key, a Play upload, a hosted change, EAS cloud or a secret. No AAB signed with a real key has been built or uploaded. Related: `Android_Release_Audit.md` (section 4 signing, sections 9-11 results), `Google_Play_Internal_Testing.md`, `Student_Release_Package_Internal_Testing.md`, `Business_Release_Package_Internal_Testing.md`, `Business_Android_Internal_Testing_Requirements.md`.

Helpers added with this document (all under `docs/mobile/tools/`, none contains a secret):

| File | What it does |
|---|---|
| `New-UploadKeystore.ps1` | The owner creates the one upload keystore (idempotent: if it exists it only prints the public fingerprints and compares them with the pin). |
| `upload-cert.json`, `Test-UploadSigner.ps1` | The pinned upload certificate and the signer check `Build-ReleaseAab.ps1` runs on every AAB (fails unless the signer SHA-256 equals the pin; always rejects the QA key). |
| `Set-UploadSigningEnv.ps1` | The owner exports the four `DANCEFLOW_UPLOAD_*` variables into one PowerShell process, passwords typed hidden. |
| `Build-ReleaseAab.ps1` | One supervised command per app: clean worktree at an exact commit, private `TEMP`, `CI` unset, unminified `bundleRelease`, then the baked-config check. |
| `verify-baked-config.js` | Decodes the Hermes string table of an AAB/APK and PASS/FAILs the baked `EXPO_PUBLIC_*` values (self-test: `--self-test`). |
| `expected-production.student.json`, `expected-production.business.json`, `release-env.example` | Expected values (no secret) and the env-file template. |

## 0. Pinned upload certificate (2026-11-20)

The owner created the upload keystore with keytool (`C:\Users\mcurt\df-credentials\upload\danceflow-upload.keystore`, alias `danceflow-upload`; engineering never reads, copies or searches for it or its passwords). Its public certificate fingerprints, pasted by the owner:

| | |
|---|---|
| SHA-256 | `12:E5:24:0E:3C:71:84:6D:11:80:B4:2D:D5:22:7E:F6:74:1B:28:7D:12:F2:DC:4C:A4:1A:B7:18:08:A1:EE:AF` |
| SHA-1 | `B3:67:50:A0:32:96:B1:B1:A3:92:29:50:13:66:35:35:35:F0:DF:92` |

These are recorded in `docs/mobile/tools/upload-cert.json`. `Build-ReleaseAab.ps1` fails (exit 1, "DO NOT UPLOAD") unless the built AAB's signer SHA-256 equals this value, and always rejects the QA key (`93:F4:E4:5E:...:F0:99`); `New-UploadKeystore.ps1` prints MATCHES / DOES NOT MATCH against it. The Play Console's *Upload key certificate* SHA-256 after the first upload must equal it too (section 1 step 5).

**Why the first run of `New-UploadKeystore.ps1` failed at the certificate export (fixed):** the script ran `keytool -exportcert ... | Out-Null`. With stdout piped, JDK 17's `System.console()` is null, so keytool can neither show its password prompt (the prompt text went into `Out-Null`) nor hide the typing, and the export failed. The key generation step had no pipe and worked, which is why the keystore existed. My earlier test used `-storepass:env` (no prompt) and so missed it. The fixed script runs both keytool calls with no pipe or redirect, lets keytool print only `Certificate stored in file ...`, and computes the SHA-256/SHA-1 itself from the public `.cer`, which it deletes. A second bug found while testing the idempotent path: `$PSScriptRoot` is empty inside a `param()` default on Windows PowerShell 5.1, so the pin-file path is now resolved in the script body. Tested on a throwaway copy of the QA keystore (password fed on stdin, so the interactive TTY prompt itself is **UNVERIFIED** until the owner re-runs): an existing keystore is not regenerated or modified (byte-identical), the fingerprints print, no `.cer` is left, and a key that is not the pinned one is flagged. The owner can simply re-run `New-UploadKeystore.ps1`: it skips generation and prints the fingerprints, which should say MATCHES.

## 1. Owner signing setup (minimal, local keystore + Play App Signing)

Facts: **one upload key may sign both apps.** Play App Signing is what Google uses for new apps: the key that signs the first uploaded AAB is registered as that app's *upload key*, and Google holds the real app-signing key. The owner does not choose a mode; the Console shows it on the app's first release screen and the first upload is the acceptance. Never share the keystore or its passwords with anyone (including engineering); engineering needs only the two public fingerprints.

The JDK 17 on this PC (the one Gradle uses) is `C:\Android\jdk-17`; its `keytool.exe` is `C:\Android\jdk-17\bin\keytool.exe` (`JAVA_HOME` is not set in every shell; the helpers use that path and take `-Keytool` to override).

1. **Create the key (owner, own PowerShell window, once; already done 2026-11-20 — re-running only prints the fingerprints):**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File <repo>\docs\mobile\tools\New-UploadKeystore.ps1
   ```
   keytool asks for the password (twice) and the name fields itself, hidden; the script never sees them. It creates `C:\Users\mcurt\df-credentials\upload\danceflow-upload.keystore` (alias `danceflow-upload`, RSA 2048, 25 years), refuses to overwrite an existing file, restricts the folder's ACL to the Windows user, prints the **SHA-256 and SHA-1 of the upload certificate**, compares them with the pin, and reminds the backups.
2. **Back it up before anything else:** password in the password manager, the `.keystore` file as a password-manager attachment **and** an offline copy (encrypted USB). Two places.
3. **The fingerprint is pinned** (section 0); the build script compares every AAB's signer certificate with it.
4. **For a supervised build** (section 4), in the same PowerShell window: `. <repo>\docs\mobile\tools\Set-UploadSigningEnv.ps1` (note the leading dot). Passwords are typed hidden; the four `DANCEFLOW_UPLOAD_*` variables exist only in that process, the keystore is opened once to prove the password (nothing printed), and `Clear-UploadSigningEnv` (or closing the window) removes them. The build script also clears them when it ends, so dot-source again before the second app.
5. **At the first upload** Play registers the signing certificate of that AAB as the upload key. After upload, open the app's *Test and release > Setup > App signing* (Console wording varies slightly) and compare **Upload key certificate SHA-256** with the fingerprint from step 1. **If they differ** the AAB was signed with a different key than intended (wrong keystore or a QA/debug key): stop, do not release, and tell engineering. With Play App Signing the upload key can be reset by Google (App signing page > *Request upload key reset*), so this is recoverable; Play will not let a key that does not match the registered upload key upload later builds.
6. If the keystore or password is ever lost, nothing is lost before the first upload (make a new key); after it, request an upload-key reset in the Console. The app-signing key is Google's, so users are not affected.

Never use the QA key (`DanceFlow QA ONLY DO NOT UPLOAD`, SHA-256 `93:F4:E4:5E:...:F0:99`) for anything uploaded.

## 2. Production runtime config (no QA placeholders)

Determined from the repo, read-only HTTP and existing docs only; **no credential was used and no hosted system was queried for a key.**

| Value (per app) | Production setting | How it was determined / status |
|---|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | `https://hvsujyfbftfffxpfmlpb.supabase.co` | Project ref `hvsujyfbftfffxpfmlpb` is PROD in the repo docs and `sb.sh`; the URL shape is fixed. The live site's CSP allows `https://*.supabase.co`, but its browser bundle does not contain the project URL (the web app talks to Supabase server-side), so the URL could not be read from the live client: **owner confirms** (requirements O6). |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | the PROD project's **anon / public** key (a JWT, `role: anon`, `ref: hvsujyfbftfffxpfmlpb`) | Not obtainable from the live web bundle or from `sb.sh` (SQL only), and fetching it through a management API would use the owner's credential, which is out of scope. **Owner input:** Supabase Dashboard > Project Settings > API > the `anon` `public` key, copied into the local env files (section 4). Never the `service_role` key. The verify script checks the baked key decodes to `role=anon`, `ref=hvsujyfbftfffxpfmlpb`, `iss=supabase`, not expired, and that it is the only JWT in the bundle. |
| `EXPO_PUBLIC_DANCEFLOW_WEB_URL` | **`https://www.idanceflow.com`** | Observed 2026-11-20 02:59Z: `https://idanceflow.com/` answers `307` to `https://www.idanceflow.com/`; `https://www.idanceflow.com/api/staff/me` answers `404` (the staff routes are not live yet: R+2), apex `/api/staff/me` answers `307`. The apps currently default to the apex (`https://idanceflow.com`, in both apps' source). A cross-host `307` can drop the `Authorization` header (standard fetch/OkHttp behaviour), so the build should name `www` directly. The coordinator confirms which origin serves `/api/staff` after R+2. |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Student) | **leave unset** | `mobile/student/src/lib/stripeConnect.ts` uses the `publishableKey` the server returns with each payment response and only falls back to this variable. The mode (live/test) is therefore the server's, not the app's, and cannot be read from the repo. The verify script's policy `"stripe": "unset"` fails the build if any `pk_` is baked in; set `"live"`/`"test"` only if the owner decides to bake the fallback. |
| `EXPO_PUBLIC_DANCEFLOW_STUDIO_SLUG` (Student) | not needed | Appears only in `.env.example`; no source reads it. |
| `EXPO_PUBLIC_STAFF_FEATURES` (Business) | default (`clients,attendance`); add `pulse,studioSchedule` **only** after the coordinator confirms the server serves `/pulse` and `/schedule` (R+2) | `mobile/business/src/lib/features.ts`: both are OFF by default; the build flag turns them on. |
| `EXPO_PUBLIC_LAYOUT_DEBUG` | never set | Dev-only. |

**The verify script** (`verify-baked-config.js <aab|apk> <expected.json>`, exit 0/1) FAILs on: `qa-placeholder`, any `https://*.invalid` host, `10.0.2.2`, `:566xx` stack ports, the QA mock-web port, a LAN address, more `localhost`/`127.0.0.1` than the library baseline (2 / 1), `service_role`, Stripe `sk_`/`rk_`/`whsec_`, a private-key marker, a Supabase project other than the expected ref, anything but exactly one JWT, a JWT whose role is not `anon` / whose `ref` differs / that is expired, a missing expected web origin, and a Stripe publishable key that violates the policy. It prints only role/ref/expiry, never a key. It is read-only and offline.

Proof it fails what it should (2026-11-20, `C:\dfr-out`): `rc5\student-rc5.aab`, `rc5\business-rc5.aab` and `rc6\business-rc6.aab` (QA placeholder builds) all **FAIL** with `found "qa-placeholder"`, `found an https://....invalid URL`, no Supabase project, 0 JWTs, web origin `https://www.idanceflow.com` not present (exit 1). `--self-test` passes 13/13 synthetic cases (good bundle PASS; placeholder, emulator URL, wrong project, service-role key, two JWTs, expired key, wrong origin, Stripe secret, publishable key under `unset`, publishable test key under `live`, extra `localhost` all FAIL; `live` key under `live` PASS). A real PASS against a production-valued artifact is **UNVERIFIED** until the owner's anon key exists; a throwaway Gradle build with the real values was not made (it needs the key).

## 3. Student `google-services.json` for the first INTERNAL build

The release Gradle guard (`mobile/student/android/app/build.gradle`) refuses `bundleRelease` without a real, package-matching `google-services.json`. `C:\Users\mcurt\df-credentials\firebase-dev\google-services.json` (Firebase project `danceflow-mobile-dev`, clients for both packages, verified by the coordinator) satisfies it.

- **Acceptable for the first internal-testing build.** It is a Firebase client config (not a private key). Consequence: the build points push at the DEV Firebase project; **production push stays UNVERIFIED** (the FCM v1 key under the production EAS project and a production Firebase project are owner items in `Google_Play_Internal_Testing.md` section 11). Internal testers can still use the app; if push is wanted later, a new build with the production file and a higher versionCode replaces it (the signing key does not change).
- **How to pass it without committing it:** `Build-ReleaseAab.ps1 -GoogleServices C:\Users\mcurt\df-credentials\firebase-dev\google-services.json`. The script runs `node scripts\google-services-check.js --copy <file> android\app\google-services.json com.idanceflow.student` inside the clean worktree (validates package id and placeholder, never prints contents); the file is gitignored and the worktree is disposable. For a manual build, set `GOOGLE_SERVICES_JSON` to the path or place the file in `mobile/student/android/app/` (untracked).
- **Business** needs no `google-services.json` for the first test (RC6 built without it; push is out of scope until the app has an EAS project id).
- Data safety: Student collects the push token (already in the Student row); Business does not mint one until `eas init`.

## 4. Candidates, pins and the supervised build

| | Student | Business |
|---|---|---|
| Candidate | RC5b (device evidence at `f794940c3`: `C:\dfr-out\qa-rc5b`) | RC6 (smoke 23/23 at `6d23af298`: `C:\dfr-out\qa-smoke21`, AAB checks in `C:\dfr-out\rc6`) |
| Build from | the exact `origin/main` SHA at go-time (`56c10076c` when this was written) **provided the app inputs are unchanged** (check below) | same |
| Changes in the app inputs since the candidate commit (`mobile/<app>` excluding `scripts`, tests, `*.md`) | none at `56c10076c` | none at `56c10076c` |
| versionCode / versionName | 1 / 0.1.0 (committed `android/app/build.gradle`) | 1 / 0.1.0 (`app.json`) |
| Build type | unminified `bundleRelease` (R8 is a candidate, not the default: RC4 forced-R8 smoke 13/13, no R8 build of RC5b/RC6) | unminified |
| Staff API | n/a | `pulse`/`studioSchedule` only if R+2 serves them (coordinator confirms) |

Pin check at go-time (must print nothing, else rebuild the evidence on the new commit):

```powershell
git fetch origin
git diff --stat f794940c3 origin/main -- mobile/student ':!mobile/student/scripts' ':!*__tests__*' ':!*.md'
git diff --stat 6d23af298 origin/main -- mobile/business ':!mobile/business/scripts' ':!*__tests__*' ':!*.md'
```

A second upload of either app needs `versionCode` 2 (edit `mobile/student/android/app/build.gradle` / `mobile/business/app.json` in a PR); Play never reuses a versionCode.

**Ordered supervised commands** (owner's go; one Gradle build at a time; nothing else running: `Get-Process java` empty, no iso-qa containers, emulator closed). Run from a checkout of main that contains this PR, in the owner's PowerShell window. Create the two env files first from `docs\mobile\tools\release-env.example` (they live in `C:\Users\mcurt\df-credentials\release\`, outside every repo):

```powershell
cd C:\Dev\studioapp; git fetch origin
$sha = git rev-parse origin/main                       # after the pin check above printed nothing
. .\docs\mobile\tools\Set-UploadSigningEnv.ps1          # hidden password prompts
.\docs\mobile\tools\Build-ReleaseAab.ps1 -App student  -Commit $sha `
   -EnvFile C:\Users\mcurt\df-credentials\release\student.env `
   -ExpectedFile .\docs\mobile\tools\expected-production.student.json `
   -GoogleServices C:\Users\mcurt\df-credentials\firebase-dev\google-services.json
. .\docs\mobile\tools\Set-UploadSigningEnv.ps1          # the build cleared them; set again
.\docs\mobile\tools\Build-ReleaseAab.ps1 -App business -Commit $sha `
   -EnvFile C:\Users\mcurt\df-credentials\release\business.env `
   -ExpectedFile .\docs\mobile\tools\expected-production.business.json
```

What each command does: refuses if Gradle/java runs or a `DANCEFLOW_UPLOAD_*` variable is missing; `git worktree add --detach C:\dfr\rel-<app> <sha>`; `npm ci`; reads only the env file's `EXPO_PUBLIC_*` (anything already in the shell is dropped); private empty `TEMP`/`TMP`, `CI` unset, JDK 17; Student copies the Firebase file, Business runs `expo prebuild --clean`; deletes `createBundleReleaseJsAndAssets`; `gradlew bundleRelease --no-daemon` (unminified); copies the AAB to `C:\dfr-out\release\<app>-<sha8>.aab`; prints size, file SHA-256, then **fails unless the signer SHA-256 equals the pinned upload certificate** (section 0; the QA key is always rejected); runs `verify-baked-config.js`. Exit 1 and "DO NOT UPLOAD" if the baked config fails. Afterwards engineering still runs the manifest/targetSdk 36/16 KB/permission checks (`Android_Release_QA_Runbook.md` step 1) and, with the coordinator's emulator slot, the device smoke of the same commit on a disposable stack. These helpers were syntax-checked and their key logic (fingerprint printing, `-storepass:env` open check) was proven on the throwaway QA keystore, **but `Build-ReleaseAab.ps1` itself has not been run end to end** (it needs the real key and the production anon key): UNVERIFIED until the first supervised run.

## 5. Tester lists: five-line reconciliation (per app, owner, about 3 minutes each)

1. Play Console > the app > *Test and release* > *Testing* > *Internal testing* > **Testers** tab.
2. Confirm the existing tester list (email list) is **attached to this track** (a ticked list, not just a created one) and shows the expected number of testers.
3. Confirm each tester's address is the **Google account they use on the device** (testers must opt in with that account).
4. Copy the **opt-in link** ("Copy link") for the track and send it to the testers only after the release below is created.
5. After the first release is created and *Saved/Rolled out* to the internal track, check the Releases tab shows the release as available to testers and compare the **Upload key certificate SHA-256** (section 1 step 5).

## 6. Exact owner actions, in order

1. Run `New-UploadKeystore.ps1`, type a long password at keytool's prompt, store the password and **two** copies of the keystore (password manager + offline). Paste the printed SHA-256 and SHA-1 lines to the coordinator.
2. Copy the PROD Supabase **anon (public)** key from Supabase Dashboard > Project Settings > API into `C:\Users\mcurt\df-credentials\release\student.env` and `business.env` (template: `docs\mobile\tools\release-env.example`; confirm the URL line). Never the `service_role` key.
3. Confirm the origin: `https://www.idanceflow.com` (the coordinator confirms `/api/staff` is served there after R+2).
4. Confirm the Supabase Auth redirect allow-list contains the apps' callback schemes (requirements O7) and the privacy-policy/account-deletion URL timing (requirements O8).
5. Say go; run (or watch engineering run) the two supervised commands in section 4 in one PowerShell window; read the printed signer fingerprint and the `BAKED CONFIG: PASS` line for each app.
6. Upload each AAB by hand in the Console (*Internal testing > Create new release > Upload*, accept Play App Signing, save and roll out to the internal track) and compare the Console's upload-key SHA-256 with step 1.
7. Do the five-line tester reconciliation (section 5) for each app.

## 7. What is still missing for the two build commands to run (2026-11-20)

Engineering side is ready; the commands in section 4 are one command each per app (plus the dot-source). Missing, and only these:

1. **The production Supabase anon key** in `C:\Users\mcurt\df-credentials\release\student.env` and `business.env` (template `docs\mobile\tools\release-env.example`; the URL and `www` origin lines are pre-filled and need the owner's confirmation; the folder does not exist yet). Not fetched by engineering.
2. **The owner's go**, with the upload keystore password typed by the owner at `Set-UploadSigningEnv.ps1`'s hidden prompt, in the shell that runs the build.
3. Two confirmations that change a value, not the commands: the coordinator's R+2 result for `/api/staff` on `www` (decides `EXPO_PUBLIC_STAFF_FEATURES` for Business and the web origin), and the pin check in section 4 printing nothing at go-time.

Not missing: the keystore (exists), its fingerprints (pinned), the JDK 17 path, the verifier (self-test passes), the expected-value files, the DEV `google-services.json` (exists, accepted for the first internal build), the pinned candidate commits. `Build-ReleaseAab.ps1` has not run end to end (UNVERIFIED until the first supervised run).
