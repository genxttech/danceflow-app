/*
  Expo config plugin: Play upload-key release signing for generated Android projects.

  `expo prebuild` writes android/app/build.gradle with `signingConfig signingConfigs.debug` in the
  release build type. This plugin rewrites that so release is signed ONLY with an upload keystore
  from environment variables or an untracked android/keystore.properties, and fails the build
  (rather than falling back to the debug key) when they are absent.

  Keep this file identical in mobile/student/plugins and mobile/business/plugins.
*/
const { withAppBuildGradle } = require("@expo/config-plugins");

const MARKER = "dfHasReleaseSigning";

const HELPER = `// ---- Release signing (Play upload key) -------------------------------------------------
// Release is signed ONLY with the upload keystore supplied through environment variables or
// an untracked android/keystore.properties. It never falls back to the debug key: when the
// credentials are absent, any assemble/bundle/package/sign Release task fails loudly.
//   DANCEFLOW_UPLOAD_STORE_FILE, DANCEFLOW_UPLOAD_STORE_PASSWORD,
//   DANCEFLOW_UPLOAD_KEY_ALIAS,  DANCEFLOW_UPLOAD_KEY_PASSWORD
// keystore.properties keys: storeFile, storePassword, keyAlias, keyPassword
def dfKeystoreProps = new Properties()
def dfKeystorePropsFile = rootProject.file('keystore.properties')
if (dfKeystorePropsFile.exists()) {
    dfKeystorePropsFile.withInputStream { dfKeystoreProps.load(it) }
}
def dfSigning = { String envName, String propName ->
    def v = System.getenv(envName) ?: dfKeystoreProps.getProperty(propName)
    return (v != null && v.trim()) ? v.trim() : null
}
def dfStoreFile = dfSigning('DANCEFLOW_UPLOAD_STORE_FILE', 'storeFile')
def dfStorePassword = dfSigning('DANCEFLOW_UPLOAD_STORE_PASSWORD', 'storePassword')
def dfKeyAlias = dfSigning('DANCEFLOW_UPLOAD_KEY_ALIAS', 'keyAlias')
def dfKeyPassword = dfSigning('DANCEFLOW_UPLOAD_KEY_PASSWORD', 'keyPassword')
def dfHasReleaseSigning = dfStoreFile && dfStorePassword && dfKeyAlias && dfKeyPassword &&
        new File(dfStoreFile).exists()

`;

const RELEASE_SIGNING_CONFIG = `        release {
            if (dfHasReleaseSigning) {
                storeFile new File(dfStoreFile)
                storePassword dfStorePassword
                keyAlias dfKeyAlias
                keyPassword dfKeyPassword
            }
        }
`;

const GUARD = `
gradle.taskGraph.whenReady { graph ->
    def releaseTask = graph.allTasks.find {
        it.project == project && it.name ==~ /^(assemble|bundle|package|sign|install)(.*)Release.*/
    }
    if (releaseTask && !dfHasReleaseSigning) {
        throw new GradleException(
            "Release signing is not configured (task \${releaseTask.path}). Set DANCEFLOW_UPLOAD_STORE_FILE, " +
            "DANCEFLOW_UPLOAD_STORE_PASSWORD, DANCEFLOW_UPLOAD_KEY_ALIAS and DANCEFLOW_UPLOAD_KEY_PASSWORD " +
            "(or create android/keystore.properties) pointing at an existing keystore. " +
            "Release builds are never signed with the debug key. See docs/mobile/Android_Release_Audit.md.")
    }
}
`;

function replaceOnce(src, needle, replacement, what) {
  if (!src.includes(needle)) {
    throw new Error(`withAndroidReleaseSigning: could not find ${what} in android/app/build.gradle`);
  }
  return src.replace(needle, () => replacement);
}

function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  let out = contents;
  out = replaceOnce(out, "android {\n    ndkVersion", `${HELPER}android {\n    ndkVersion`, "android block");
  // Add a release signing config after the generated debug one.
  out = replaceOnce(
    out,
    "            keyPassword 'android'\n        }\n",
    `            keyPassword 'android'\n        }\n${RELEASE_SIGNING_CONFIG}`,
    "debug signingConfig"
  );
  // The release build type must not use the debug key.
  const releaseRegex = /(release \{\n)(\s*\/\/ Caution![^\n]*\n\s*\/\/ see [^\n]*\n)?(\s*)signingConfig signingConfigs\.debug\n/;
  if (!releaseRegex.test(out)) {
    throw new Error("withAndroidReleaseSigning: could not find release signingConfig");
  }
  out = out.replace(
    releaseRegex,
    (_m, head, _c, indent) =>
      `${head}${indent}// Never the debug key: release uses the upload key, or the build fails (see top of file).\n${indent}signingConfig dfHasReleaseSigning ? signingConfigs.release : null\n`
  );
  out = out.replace(/\s*$/, "\n") + GUARD;
  // Keep the google-services apply last if present.
  const gms = "apply plugin: 'com.google.gms.google-services'";
  if (out.includes(gms)) {
    out = out.replace(`\n${gms}`, "").replace(/\s*$/, "\n") + `\n${gms}\n`;
  }
  return out;
}

module.exports = function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });
};
module.exports.applyReleaseSigning = applyReleaseSigning;
