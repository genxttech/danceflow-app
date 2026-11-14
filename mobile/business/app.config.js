const appJson = require("./app.json");
const { checkGoogleServices } = require("./scripts/google-services-check");

/*
  Dynamic config for DanceFlow Business.

  - No EAS project id is invented here. Until the owner runs `eas init` (which writes
    expo.extra.eas.projectId and expo.owner into app.json) there is no updates URL and no
    EAS-linked builds. This app does not use expo-updates today, so no updates block is added.
  - The Business app has no push notifications or Firebase dependency today. When it gains
    push, supply the real file through GOOGLE_SERVICES_JSON (an EAS file secret or a local
    path); it is only wired in when that variable is set, never from a committed placeholder.
*/
module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON;

  if (googleServicesFile) {
    const result = checkGoogleServices(googleServicesFile, appJson.expo.android.package, {
      allowPlaceholder: process.env.EAS_BUILD_PROFILE !== "production",
    });
    if (!result.ok) throw new Error(`GOOGLE_SERVICES_JSON rejected: ${result.reason}`);
  }

  return {
    ...config,
    ...appJson.expo,
    android: {
      ...appJson.expo.android,
      ...(googleServicesFile ? { googleServicesFile } : {}),
    },
  };
};
