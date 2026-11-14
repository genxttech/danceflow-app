const appJson = require("./app.json");
const { checkGoogleServices } = require("./scripts/google-services-check");

/*
  Dynamic config for DanceFlow Business.

  - No EAS project id is invented here. Until the owner runs `eas init` (which writes
    expo.extra.eas.projectId and expo.owner into app.json) there is no updates URL and no
    EAS-linked builds. This app does not use expo-updates today, so no updates block is added.
  - The Business app carries the expo-notifications plugin (token registration lands separately).
    Android push needs a real Firebase file: supply it through GOOGLE_SERVICES_JSON (an EAS file
    variable or a local path). It is only wired in when that variable is set and passes
    scripts/google-services-check.js (package id match; the QA placeholder is rejected for
    production builds), never from a committed file.
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
