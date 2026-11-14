import AsyncStorage from "@react-native-async-storage/async-storage";

/*
  Where to land after sign-in. Sign-in leaves the app (the magic link opens from email), so a
  screen that sends a signed-out dancer to sign-in remembers where they were, and the auth
  callback returns them there instead of Today.

  Not sensitive (an in-app route), but still allow-listed: only those routes, only for an hour,
  and read once.
*/

const KEY = "danceflow.postSignInRoute";
const MAX_AGE_MS = 60 * 60 * 1000;
// Event pages, plus the places a signed-out visitor to Discover is sent to sign in from.
const ALLOWED = [
  /^\/events\/[A-Za-z0-9_-]{1,64}$/,
  /^\/\(tabs\)\/discover$/,
  /^\/(partners|jobs|discover\/marketplace)$/,
];

export function isAllowedPostSignInRoute(path: string) {
  return ALLOWED.some((pattern) => pattern.test(path));
}

export async function rememberPostSignInRoute(path: string, now = Date.now()) {
  if (!isAllowedPostSignInRoute(path)) return;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ path, at: now }));
  } catch {
    // Losing the return route only means landing on Today.
  }
}

/** The remembered route, if still valid; always clears it. */
export async function takePostSignInRoute(now = Date.now()): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    await AsyncStorage.removeItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof value.path !== "string" || typeof value.at !== "number") return null;
    if (now - value.at > MAX_AGE_MS || value.at > now) return null;
    return isAllowedPostSignInRoute(value.path) ? value.path : null;
  } catch {
    return null;
  }
}
