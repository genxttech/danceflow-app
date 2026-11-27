import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

/*
  The server-controlled app configuration (owner decision H8, 2026-11-26; design in docs/mobile/Student_Min_Version_And_Kill_Switch_Design.md).
  First step: a SOFT update notice only. Nothing here can block a screen, turn a feature off or sign anyone out.

  It fails open: no answer, a slow answer, an answer that is not exactly the expected shape, or a build whose own number is unknown all mean
  "nothing to show". The file is public static JSON (no sign-in, no personal data is sent), and nothing in it is shown as text: the app
  writes its own words, and the only link it will open is its own store page.
*/

const DEFAULT_WEB_BASE_URL = "https://idanceflow.com";
export const APP_CONFIG_PATH = "/app-config/student.json";
export const APP_CONFIG_TIMEOUT_MS = 3000;
export const APP_CONFIG_MAX_CHARS = 4096;
/** How long a fetched answer is trusted without being fetched again (also how long a withdrawn notice can linger on an offline phone). */
export const APP_CONFIG_CACHE_MS = 24 * 60 * 60 * 1000;
export const APP_CONFIG_REFRESH_MS = 15 * 60 * 1000;
export const NOTICE_DISMISS_MS = 3 * 24 * 60 * 60 * 1000;

const CACHE_KEY = "danceflow-app-config";
const DISMISS_KEY = "danceflow-update-notice-dismissed";
const MAX_BUILD_NUMBER = 2_100_000_000;

export type PlatformConfig = { recommendedCode: number; storeUrl: string | null };
export type UpdateNotice = { recommendedCode: number; storeUrl: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isBuildNumber = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_BUILD_NUMBER;

/** Only this app's own store pages. Anything else becomes "no link" (the notice then has no Update button). */
export function safeStoreUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "https://play.google.com/store/apps/details?id=com.idanceflow.student") return value;
  return /^https:\/\/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:[a-z0-9-]+\/)?id\d{5,15}$/.test(value) ? value : null;
}

/** The student app's entry for one platform from a schema 1 document, or null if anything about it is not as expected. */
export function parseAppConfig(document: unknown, platform: "android" | "ios"): PlatformConfig | null {
  if (!isRecord(document) || document.schema !== 1 || !isRecord(document.apps) || !isRecord(document.apps.student)) return null;
  const entry = document.apps.student[platform];
  if (!isRecord(entry) || !isBuildNumber(entry.recommendedCode)) return null;
  return { recommendedCode: entry.recommendedCode, storeUrl: safeStoreUrl(entry.storeUrl) };
}

/**
 * This build's integer build number (Android versionCode, iOS buildNumber) from the app config baked into it. Right for the local release
 * path (Build-ReleaseAab.ps1 prebuilds from app.json). An EAS build with a remote version source assigns the number at build time and this
 * value may then be lower than the installed one; if EAS builds are ever shipped, read the native build number instead (needs
 * expo-application as a direct dependency). iOS has no buildNumber in app.json today, so no notice appears there.
 */
export function ownBuildNumber(): number | null {
  const config = Constants.expoConfig;
  const raw = Platform.OS === "ios" ? config?.ios?.buildNumber : config?.android?.versionCode;
  const value = typeof raw === "string" && /^\d{1,10}$/.test(raw) ? Number(raw) : raw;
  return isBuildNumber(value) && value > 0 ? value : null;
}

async function fetchDocument(): Promise<unknown> {
  const base = (process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? DEFAULT_WEB_BASE_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), APP_CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${APP_CONFIG_PATH}`, { credentials: "omit", headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > APP_CONFIG_MAX_CHARS) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null; // answered, but not JSON: nothing to show, and the earlier answer is forgotten
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The configuration for this platform: freshly fetched when possible (and remembered), else the last good answer for up to 24 hours, else
 * null. A fresh answer that is invalid or missing clears the memory, so withdrawing the file withdraws the notice. Never throws.
 */
export async function loadAppConfig(now = Date.now()): Promise<PlatformConfig | null> {
  const platform = Platform.OS === "ios" ? "ios" : "android";
  let document: unknown;
  try {
    document = await fetchDocument();
  } catch {
    // Could not ask (offline, timeout): fall back to a recent answer.
    try {
      const cached = JSON.parse((await AsyncStorage.getItem(CACHE_KEY)) ?? "null") as unknown;
      if (!isRecord(cached) || typeof cached.at !== "number" || now - cached.at > APP_CONFIG_CACHE_MS || now < cached.at) return null;
      return parseAppConfig(cached.document, platform);
    } catch {
      return null;
    }
  }

  const parsed = parseAppConfig(document, platform);
  try {
    if (parsed) await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: now, document }));
    else await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Remembering is a convenience; the answer in hand is still used.
  }
  return parsed;
}

/** The notice to show for a build, or null: only a recommended build number higher than this one's shows anything. */
export function updateNoticeFor(config: PlatformConfig | null, ownCode: number | null): UpdateNotice | null {
  if (!config || ownCode === null || config.recommendedCode <= ownCode) return null;
  return { recommendedCode: config.recommendedCode, storeUrl: config.storeUrl };
}

// Also remembered in memory, so a failed write cannot bring the card back while the app is running.
const dismissedThisRun = new Map<number, number>();

/** Whether the dancer put this notice away in the last three days. A newer recommendation shows again at once. */
export async function isNoticeDismissed(recommendedCode: number, now = Date.now()): Promise<boolean> {
  const recent = dismissedThisRun.get(recommendedCode);
  if (recent !== undefined && now >= recent && now - recent < NOTICE_DISMISS_MS) return true;
  try {
    const stored = JSON.parse((await AsyncStorage.getItem(DISMISS_KEY)) ?? "null") as unknown;
    if (!isRecord(stored) || stored.code !== recommendedCode || typeof stored.at !== "number") return false;
    return now >= stored.at && now - stored.at < NOTICE_DISMISS_MS;
  } catch {
    return false;
  }
}

export async function dismissNotice(recommendedCode: number, now = Date.now()) {
  dismissedThisRun.set(recommendedCode, now);
  try {
    await AsyncStorage.setItem(DISMISS_KEY, JSON.stringify({ code: recommendedCode, at: now }));
  } catch {
    // It stays hidden for this session either way.
  }
}
