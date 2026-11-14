// EAS Build hook (bare workflow: android/ is committed and gitignored files are not uploaded).
// Copies the GOOGLE_SERVICES_JSON file variable to android/app/google-services.json after
// validating the package id; production builds additionally reject the QA placeholder.
const { execFileSync } = require("child_process");
const src = process.env.GOOGLE_SERVICES_JSON;
if (!src) {
  if (process.env.EAS_BUILD_PROFILE === "production") {
    console.error("GOOGLE_SERVICES_JSON is not set for a production build (create the EAS file variable).");
    process.exit(1);
  }
  console.log("GOOGLE_SERVICES_JSON not set; leaving android/app/google-services.json as is.");
  process.exit(0);
}
const args = ["scripts/google-services-check.js", "--copy", src, "android/app/google-services.json", "com.idanceflow.student"];
if (process.env.EAS_BUILD_PROFILE !== "production") args.push("--allow-placeholder");
execFileSync(process.execPath, args, { stdio: "inherit" });
