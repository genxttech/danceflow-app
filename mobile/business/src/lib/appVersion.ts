import Constants from "expo-constants";
import { Platform } from "react-native";

/*
  X-DanceFlow-App: business/<versionName>/<versionCode>/<android|ios>   e.g. business/0.2.0/3/android

  The server's write gate (src/lib/staff/writeGuard.ts, docs/mobile/Staff_API_Contract.md "Write gate") refuses a gated write that does not carry it
  (426 upgrade_required), so a build that cannot work out its own version sends no header and is simply refused for writes: fail closed.

  The version code comes from the build's app config (android.versionCode / ios.buildNumber). That is exact for builds made through the local Gradle path
  (Build-ReleaseAab.ps1 reads app.json). An EAS build with appVersionSource "remote" assigns the code at build time and expo-constants may still show the
  app.json value; if EAS builds are ever used for Business, add expo-application (nativeBuildVersion) here. (package.json is a protected path, so not done in this change.)
*/

type ConfigLike = { version?: string | null; android?: { versionCode?: number | string | null } | null; ios?: { buildNumber?: string | number | null } | null } | null | undefined;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;

export function buildAppHeader(config: ConfigLike, os: string): string | null {
  const platform = os === "android" ? "android" : os === "ios" ? "ios" : null;
  if (!platform) return null;
  const version = config?.version;
  const rawCode = platform === "android" ? config?.android?.versionCode : config?.ios?.buildNumber;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" && /^\d{1,9}$/.test(rawCode) ? Number(rawCode) : NaN;
  if (!Number.isInteger(code) || code < 0 || code > 2_000_000_000) return null;
  return `business/${version}/${code}/${platform}`;
}

export function currentAppHeader(): string | null {
  return buildAppHeader(Constants.expoConfig as ConfigLike, Platform.OS);
}
