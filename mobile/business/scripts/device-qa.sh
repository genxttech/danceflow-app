#!/usr/bin/env bash
# Device QA helper for the DanceFlow Business debug development build on a LOCAL Android emulator.
# Uses the shared JDK / Android SDK described in docs/mobile/Local_Android_QA.md (never installs its own).
# Every step only touches the emulator (adb -e); it refuses to run against a physical device.
#
#   bash scripts/device-qa.sh check                 # adb, emulator, app installed?
#   bash scripts/device-qa.sh build                 # local debug dev build + install (expo run:android)
#   bash scripts/device-qa.sh storage               # is the session in SecureStore only (no plaintext token anywhere)?
#   bash scripts/device-qa.sh restart               # force-stop and relaunch (session persistence)
#   bash scripts/device-qa.sh deeplink '<url>'      # open danceflow-business://auth/callback?code=... in the app
#   bash scripts/device-qa.sh textsize <1.0|1.3|2.0> # system font scale
#   bash scripts/device-qa.sh motion <on|off>       # Android "Remove animations" (React Native reads it as Reduce Motion)
#   bash scripts/device-qa.sh motion-log            # what the app last logged for reduceMotion
#   bash scripts/device-qa.sh shot <name>           # screenshot to ./device-qa-out/<name>.png
#   bash scripts/device-qa.sh reset                 # text size 1.0, animations back on
set -euo pipefail

APP_ID="com.idanceflow.business"
OUT_DIR="${DEVICE_QA_OUT:-./device-qa-out}"

die() { echo "device-qa: $*" >&2; exit 2; }

ADB="${ADB:-}"
if [ -z "$ADB" ]; then
  if [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/platform-tools/adb" ]; then ADB="$ANDROID_HOME/platform-tools/adb"
  elif [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/platform-tools/adb.exe" ]; then ADB="$ANDROID_HOME/platform-tools/adb.exe"
  elif command -v adb >/dev/null 2>&1; then ADB="adb"
  else die "adb not found: set ANDROID_HOME from docs/mobile/Local_Android_QA.md"; fi
fi

# emulator only: -e targets the single running emulator and fails if none (or a physical device is the only target)
adbe() { "$ADB" -e "$@"; }

require_emulator() {
  local serial
  serial="$("$ADB" -e get-serialno 2>/dev/null || true)"
  case "$serial" in emulator-*) ;; *) die "no running emulator (adb -e get-serialno: '${serial:-none}')";; esac
}

cmd="${1:-}"; shift || true
case "$cmd" in
  check)
    "$ADB" version | head -1
    require_emulator
    echo "emulator: $("$ADB" -e get-serialno)"
    if adbe shell pm list packages | tr -d '\r' | grep -qx "package:$APP_ID"; then echo "app: installed"; else echo "app: NOT installed (run: build)"; fi
    ;;
  build)
    require_emulator
    [ -n "${JAVA_HOME:-}" ] || die "JAVA_HOME is not set (see docs/mobile/Local_Android_QA.md)"
    [ -n "${ANDROID_HOME:-}" ] || die "ANDROID_HOME is not set (see docs/mobile/Local_Android_QA.md)"
    npx expo run:android --variant debug
    ;;
  storage)
    require_emulator
    # debug builds allow run-as; SecureStore keeps values encrypted under the Android Keystore in its own preferences file
    echo "-- shared_prefs files:"
    # Pass each remote command as ONE string: `sh -c '…'` quoting does not survive adb shell + run-as (the first version of
    # this check silently scanned nothing). files/ is skipped: in a dev build it holds the JS bundle, which contains
    # supabase-js code that mentions access_token without being a token.
    prefs="$(adbe shell "run-as $APP_ID ls shared_prefs" | tr -d '\r' || true)"
    [ -n "$prefs" ] || { echo "BLOCKED: cannot read app storage (is this a debug build, installed, and opened once?)"; exit 3; }
    echo "$prefs"
    echo "-- positive control: a name that is stored is found (proves the scan reads the files):"
    control="$(adbe shell "run-as $APP_ID grep -rl auth-token shared_prefs" | tr -d '\r' || true)"
    echo "${control:-(none: signed out, so there is nothing to protect; sign in first for a meaningful scan)}"
    echo "-- JWTs (eyJ…) or token field names in shared_prefs and databases (expect none):"
    # grep exits 1 when nothing matches, which is the passing case: don't let set -e/pipefail end the script there
    hits="$(adbe shell "run-as $APP_ID grep -rlE 'eyJ|access_token|refresh_token' shared_prefs databases" | tr -d '\r' || true)"
    if [ -n "$hits" ]; then echo "FAIL plaintext session material in: $hits"; exit 1; fi
    echo "PASS no plaintext token in app storage"
    echo "-- SecureStore entries (names only; values are Keystore ciphertext):"
    adbe shell "run-as $APP_ID cat shared_prefs/SecureStore.xml" | tr -d '\r' | grep -oE 'name="[^"]*"' | head -20 || echo "(no SecureStore entries)"
    ;;
  restart)
    require_emulator
    adbe shell am force-stop "$APP_ID"
    sleep 1
    adbe shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
    echo "relaunched $APP_ID (a dev build reconnects to Metro; confirm the Today screen, not sign-in)"
    ;;
  deeplink)
    require_emulator
    url="${1:-}"
    case "$url" in danceflow-business://auth/callback\?*) ;; *) die "expected danceflow-business://auth/callback?... (got '$url')";; esac
    adbe shell am start -W -a android.intent.action.VIEW -d "'$url'" "$APP_ID"
    ;;
  textsize)
    require_emulator
    scale="${1:-}"
    case "$scale" in 1.0|1.15|1.3|1.5|1.8|2.0) ;; *) die "scale must be one of 1.0 1.15 1.3 1.5 1.8 2.0";; esac
    adbe shell settings put system font_scale "$scale"
    echo "font_scale=$(adbe shell settings get system font_scale | tr -d '\r')"
    ;;
  motion)
    require_emulator
    case "${1:-}" in
      on) v=0 ;;   # reduce motion ON = animations removed
      off) v=1 ;;
      *) die "motion on|off" ;;
    esac
    for k in window_animation_scale transition_animation_scale animator_duration_scale; do adbe shell settings put global "$k" "$v"; done
    echo "animator_duration_scale=$(adbe shell settings get global animator_duration_scale | tr -d '\r') (0 = Reduce Motion on)"
    ;;
  motion-log)
    require_emulator
    adbe logcat -d -s ReactNativeJS:V | grep "reduceMotion=" | tail -3 || echo "(no reduceMotion log yet: open the app in the dev build)"
    ;;
  shot)
    require_emulator
    name="${1:-}"; [ -n "$name" ] || die "shot <name>"
    mkdir -p "$OUT_DIR"
    adbe exec-out screencap -p > "$OUT_DIR/$name.png"
    echo "$OUT_DIR/$name.png"
    ;;
  reset)
    require_emulator
    adbe shell settings put system font_scale 1.0
    for k in window_animation_scale transition_animation_scale animator_duration_scale; do adbe shell settings put global "$k" 1; done
    echo "reset text size and animations"
    ;;
  *)
    sed -n '2,17p' "$0"
    exit 2
    ;;
esac
