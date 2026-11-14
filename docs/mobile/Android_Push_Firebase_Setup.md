# Android push (FCM) setup for the DanceFlow mobile apps

Status 2026-11-14. Nothing in this document has been done: no Firebase project, Google Cloud project, Play Console setting or Expo credential was created or changed by engineering. Every action below needs the owner.

## How the apps register for push today (verified in the repo)

**DanceFlow (student, `com.idanceflow.student`)** — `mobile/student/src/lib/pushNotifications.ts`:

1. The `expo-notifications` plugin is configured; the manifest carries the default notification icon and colour.
2. After sign-in and (if needed) the permission prompt, the app calls `Notifications.getExpoPushTokenAsync({ projectId })`, where the project id is `extra.eas.projectId` = `122aaca5-d8eb-4ad9-84bc-f05c0e3bb8d1` (EAS owner `idanceflow`).
3. It sends the resulting `ExponentPushToken[...]` to the server with the `claim_mobile_push_token` RPC (`p_platform`, `p_app_slug: "danceflow-student"`), which moves the row to the signed-in user. Sign-out deletes the row from `mobile_push_tokens`.
4. The server sends through the **Expo push service**, which delivers to Android through **FCM HTTP v1**. Expo therefore needs an FCM v1 service-account key for this project, and the installed app needs a `google-services.json` that matches its package id.

**DanceFlow Business (`com.idanceflow.business`)** — has no `expo-notifications`, no Firebase and no token registration today. It needs **no** Firebase setup for the first Play internal-testing release. Do the steps for Business only when the Business app gets push.

## Finding for the student app (not changed here; owner of `mobile/student/src`)

`pushNotifications.ts` never calls `setNotificationChannelAsync`. Expo's guidance is to create a channel before requesting notification permission on Android 13+ and to use it for delivery. Without one, Android creates a fallback channel named "Miscellaneous" on first delivery, and the permission prompt behaviour on a real device is unverified. Recommended: create a `default` channel (name "DanceFlow", importance DEFAULT) at registration and have the server send `channelId: "default"`. This could not be verified here because getting a token needs real FCM credentials (see Student_App_P0_Release.md: push claim/delivery BLOCKED).

## Owner actions, in order

1. **Firebase project.** Open https://console.firebase.google.com → *Create a project* (or *Add project*). Name: `DanceFlow`. Google Analytics: off is fine (nothing in the apps uses it; leave it off so the Data safety form stays simple). Use the Google account that owns the Play Console and the Expo `idanceflow` account where possible.
2. **Register the student Android app.** Project overview → *Add app* → Android. *Android package name*: `com.idanceflow.student` (exactly). *App nickname*: `DanceFlow`. *Debug signing certificate SHA-1*: leave blank (not needed: the apps use no Google Sign-In, phone auth or dynamic links). Download `google-services.json`. Do not commit it, paste it into chat or put it in a ticket.
3. **Store `google-services.json` for EAS builds** (it is read through `process.env.GOOGLE_SERVICES_JSON` in `mobile/student/app.config.js`). From `mobile/student` once logged in as the Expo owner:
   ```bash
   eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --visibility secret --value ./google-services.json
   ```
   Repeat for `preview` if internal preview builds should receive push. For a local build, set `GOOGLE_SERVICES_JSON` to the file's path in the shell instead.
4. **FCM v1 service-account key for Expo.** Firebase console → *Project settings* (gear) → *Service accounts* → *Generate new private key*. Then, from `mobile/student`: `eas credentials` → *Android* → profile `production` → *Google Service Account* → *Manage your Google Service Account Key for Push Notifications (FCM V1)* → *Upload a new service account key*. Delete the downloaded JSON from disk afterwards. This is a **different** key from the Play submit key in step 6.
5. **Play App Signing SHA fingerprints: not required.** The apps do not use Google Sign-In, dynamic links or phone auth. If any of those is added later, copy the *App signing key certificate* and *Upload key certificate* SHA-1 and SHA-256 from Play Console → *Test and release* → *App signing* into Firebase → Project settings → the Android app → *Add fingerprint*.
6. **(Only for automated `eas submit`)** Play Console → *Users and permissions* / Google Cloud service account with Play API access. Not needed for the manual upload procedure in `Google_Play_Internal_Testing.md`, which is the recommended first release. Skip unless you want `eas submit`.
7. **Verify on a device** after the first internal build installs from Play: sign in, accept the notification prompt, confirm a row appears in `mobile_push_tokens` for the user, then send a test through https://expo.dev/notifications with that token. Re-run the "Push token claim and delivery" row in `Student_App_P0_Release.md`.

## When Business gets push

Repeat steps 2–4 for `com.idanceflow.business` (a second Android app in the same Firebase project, its own `google-services.json`, the same FCM v1 key), add the `expo-notifications` plugin and an EAS project id (`eas init` in `mobile/business`, which also needs `expo.owner`), and note the Data safety form changes (push tokens would then be collected by that app).

## Update 2026-11-14: Firebase DEV project exists

The owner created Firebase project **`danceflow-mobile-dev`** (FCM API v1 enabled, legacy messaging disabled) and registered both Android apps. The two downloaded `google-services.json` files are byte-identical project-level files holding both clients (`com.idanceflow.student` and `com.idanceflow.business`), so there is no consumer/Business mix-up to avoid beyond the build-time package check below. Engineering copied one to `C:\Users\mcurt\df-credentials\firebase-dev\google-services.json` (outside every repo) and never printed or committed it.

### Decision: Expo Push Service, not direct FCM

Verified from the code: the apps register an **Expo push token** (`getExpoPushTokenAsync`, stored by the `claim_mobile_push_token` RPC in `mobile_push_tokens.expo_push_token`), and the server sender `src/lib/notifications/expoPush.ts` POSTs batches to `https://exp.host/--/api/v2/push/send` (no access token, no `channelId`). There is no FCM client, no Firebase Admin SDK and no FCM token anywhere server-side. So Expo's push service relays to FCM v1, and the only Google credential in the delivery path is the **FCM v1 service-account key uploaded to Expo** (per EAS project). The app-side `google-services.json` is still needed so the device can obtain an FCM registration for Expo to target. Direct FCM would mean a new sender, token type and database column; not worth it.

Consequences: Expo's push security (enhanced access token) is off today; consider enabling it and sending `Authorization: Bearer <EXPO_ACCESS_TOKEN>` later. The server sends to every enabled token of a user regardless of `app_slug`, so a person signed in to both apps gets both. Business needs an EAS project id before it can mint an Expo token.

### Build-time checks (this change)

- `scripts/google-services-check.js` (identical in both apps) fails when the file is missing, malformed, has no client for the app's package id, or is the QA placeholder.
- `app.config.js` (both apps) runs it whenever `GOOGLE_SERVICES_JSON` is set; `EAS_BUILD_PROFILE=production` also rejects the placeholder.
- Student `eas-build-post-install` copies the validated file to `android/app/google-services.json` (needed because `android/` is committed and gitignored files are not uploaded to EAS).
- Student `android/app/build.gradle` refuses any `bundle/assemble…Release` with a missing, wrong-package or placeholder `google-services.json` unless `-PallowPlaceholderGoogleServices=true` is passed (local verification builds only).
- Local use: `node scripts/google-services-check.js --copy "C:\Users\mcurt\df-credentials\firebase-dev\google-services.json" android/app/google-services.json com.idanceflow.student`

### Fingerprints

No Firebase feature used by either app (Expo push via FCM v1, Supabase email auth) needs an app SHA registered; skip them. If Google Sign-In, dynamic links or phone auth are ever added, register: **QA-only keystore (local tests only, throwaway)** SHA-1 `39:6D:68:0B:76:A5:A5:E3:16:0A:62:FF:D8:75:AA:69:AD:90:CA:A7`, SHA-256 `93:F4:E4:5E:1B:B7:4F:C9:31:F4:D8:F7:C9:4A:CE:0B:AC:BA:F7:D4:7F:5E:32:A8:86:DD:BD:9D:0A:D8:F0:99`; the committed debug keystore SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`; and, from Play Console → *App signing*, the real **upload key** and **App signing key** SHA-1/SHA-256 (not known until the owner creates the key and the first AAB is uploaded).

### Credentials that need the owner

1. **FCM v1 service-account key → Expo.** Firebase console → danceflow-mobile-dev → Project settings → Service accounts → *Generate new private key* (the default `firebase-adminsdk-…` service account, whose Firebase Admin SDK role includes sending FCM messages; no extra IAM role needed), then `eas credentials` (Android → Push Notifications FCM V1 → upload) in `mobile/student`. **A file named `danceflow-mobile-dev-firebase-adminsdk-…json` is already sitting in `C:\Users\mcurt\Downloads`: that is a private key. Engineering did not open it. Upload it to Expo as above, then delete it from Downloads.** Business later needs the same key uploaded under its own EAS project.
2. Real file as EAS variable for builds: `eas env:create --environment production --name GOOGLE_SERVICES_JSON --type file --visibility secret --value <path>` (repeat per environment).
3. Business: `eas init` in `mobile/business` (creates its EAS project id; adds `expo.owner`).

### DEV push-delivery test

Prereqs: a Google Play image emulator (the shared `df-api35` uses `google_apis`, which includes Google Play Services/FCM), a release-or-debug student build that contains the real DEV `google-services.json`, an EAS project id (student has one) and the FCM v1 key uploaded to Expo (owner step 1). Without that key Expo accepts the message but FCM rejects it (`InvalidCredentials`).

1. Install the build, sign in to a DEV/local account, accept notification permission → the app calls `claim_mobile_push_token`; read the token from the `mobile_push_tokens` row.
2. Send: `curl -X POST https://exp.host/--/api/v2/push/send -H "Content-Type: application/json" -d '{"to":"ExponentPushToken[...]","title":"DanceFlow test","body":"DEV push"}'` (or https://expo.dev/notifications). Then fetch the receipt from `https://exp.host/--/api/v2/push/getReceipts`.
3. Expect the notification on the emulator and the tap to route as in `routeFromNotificationData`.
The registration half can be run today with the real file; delivery stays BLOCKED until owner step 1.
