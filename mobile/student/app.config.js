const appJson = require("./app.json");
const { checkGoogleServices } = require("./scripts/google-services-check");

const easProjectId =
  appJson.expo.extra?.eas?.projectId || "122aaca5-d8eb-4ad9-84bc-f05c0e3bb8d1";

// A supplied GOOGLE_SERVICES_JSON must hold this app's package; production builds must also be real.
if (process.env.GOOGLE_SERVICES_JSON) {
  const result = checkGoogleServices(process.env.GOOGLE_SERVICES_JSON, appJson.expo.android.package, {
    allowPlaceholder: process.env.EAS_BUILD_PROFILE !== "production",
  });
  if (!result.ok) throw new Error(`GOOGLE_SERVICES_JSON rejected: ${result.reason}`);
}

module.exports = ({ config }) => ({
  ...config,
  ...appJson.expo,
  plugins: Array.from(
    new Set([...(appJson.expo.plugins || []), "expo-video"])
  ),
  updates: {
    ...(appJson.expo.updates || {}),
    url: `https://u.expo.dev/${easProjectId}`,
  },
  android: {
    ...appJson.expo.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON || "./google-services.json",
    runtimeVersion: "1.0.0",
  },
  ios: {
    ...appJson.expo.ios,
    runtimeVersion: {
      policy: "appVersion",
    },
  },
  extra: {
    ...appJson.expo.extra,
    eas: {
      ...appJson.expo.extra?.eas,
      projectId: easProjectId,
    },
  },
});
