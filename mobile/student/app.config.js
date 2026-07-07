const appJson = require("./app.json");

const easProjectId =
  appJson.expo.extra?.eas?.projectId || "122aaca5-d8eb-4ad9-84bc-f05c0e3bb8d1";

module.exports = ({ config }) => ({
  ...config,
  ...appJson.expo,
  updates: {
    ...(appJson.expo.updates || {}),
    url: `https://u.expo.dev/${easProjectId}`,
  },
  android: {
    ...appJson.expo.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON || "./google-services.json",
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
