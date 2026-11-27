import { Linking } from "react-native";

/*
  Studio-supplied links (a job's apply URL, a recap's shared links, a studio website) are typed by a studio, not by DanceFlow. Only web links
  are opened: a custom scheme (another app's deep link, intent:, javascript:, or danceflow://auth/... ) could otherwise be launched by one tap on
  a button that looks like a normal link.
*/

export function safeWebUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  // A studio may type a bare host ("studio.example.test/apply"): treat that as https. Anything else without a web scheme is refused.
  const candidate = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    return protocol === "https:" || protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Opens a web link; returns false (and opens nothing) for anything that is not an http(s) URL or that the device cannot open. */
export async function openWebUrl(value: string | null | undefined): Promise<boolean> {
  const url = safeWebUrl(value);
  if (!url) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
