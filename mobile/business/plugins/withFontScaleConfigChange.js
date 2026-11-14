/*
  Lets MainActivity handle a system text-size change itself.

  Expo's manifest does not list `fontScale` in android:configChanges, so changing the system text size while the app is
  open makes Android recreate the activity. React Native then keeps its old shadow tree: glyphs grow but the boxes keep
  their old heights, so labels and buttons are clipped (seen on the emulator at 2.0, release build). With fontScale handled
  by the app nothing is recreated: the layout stays consistent and the new size applies at the next launch.
*/
const { withAndroidManifest } = require("expo/config-plugins");

function addFontScale(manifest) {
  const application = manifest?.manifest?.application?.[0];
  const activity = application?.activity?.find((a) => a.$["android:name"] === ".MainActivity");
  if (!activity) return manifest;
  const current = activity.$["android:configChanges"] ?? "";
  const parts = current.split("|").filter(Boolean);
  if (!parts.includes("fontScale")) activity.$["android:configChanges"] = ["fontScale", ...parts].join("|");
  return manifest;
}

module.exports = function withFontScaleConfigChange(config) {
  return withAndroidManifest(config, (c) => {
    c.modResults = addFontScale(c.modResults);
    return c;
  });
};
module.exports.addFontScale = addFontScale;
