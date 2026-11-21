/*
  Per-build Dancer feature words, from EXPO_PUBLIC_DANCER_FEATURES (comma list). Every word is OFF unless named, and no default build config
  names any. "lumiAssistant" turns on the in-app LUMI assistant (A1 groundwork: a local stub, no network chat); it ALSO requires the server's
  per-studio `lumiEnabled`, so a build with the word on still shows nothing for a dancer whose studio has LUMI off.
*/

export type DancerFeature = "lumiAssistant";

const isFeature = (value: string): value is DancerFeature => value === "lumiAssistant";

export function parseDancerFeatures(raw: string | undefined): Set<DancerFeature> {
  const enabled = new Set<DancerFeature>();
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim();
    if (value === "none") enabled.clear();
    else if (value.startsWith("-") && isFeature(value.slice(1))) enabled.delete(value.slice(1) as DancerFeature);
    else if (isFeature(value)) enabled.add(value);
  }
  return enabled;
}

const enabled = parseDancerFeatures(process.env.EXPO_PUBLIC_DANCER_FEATURES);

export function isDancerFeatureEnabled(feature: DancerFeature) {
  return enabled.has(feature);
}
