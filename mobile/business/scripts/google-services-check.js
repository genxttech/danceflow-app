#!/usr/bin/env node
/*
  Validates a google-services.json before it is used by a build, without ever printing its
  contents (it holds an API key and app ids).

    node scripts/google-services-check.js <path> <expectedPackage> [--allow-placeholder]
    node scripts/google-services-check.js --copy <src> <dest> <expectedPackage> [--allow-placeholder]

  Fails (exit 1) when the file is missing, is not valid JSON, has no client whose package_name
  equals the app's package id, or is the local-QA placeholder (unless --allow-placeholder).
  A Firebase project-level file may hold several apps (consumer + Business); that is fine as
  long as it holds this app's package. Keep this file identical in student/ and business/.
*/
const fs = require("fs");

function checkGoogleServices(filePath, expectedPackage, { allowPlaceholder = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: `google-services.json not found at ${filePath || "(no path given)"}` };
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { ok: false, reason: "google-services.json is not valid JSON" };
  }
  const clients = Array.isArray(json.client) ? json.client : [];
  const packages = clients.map((c) => c?.client_info?.android_client_info?.package_name).filter(Boolean);
  if (!packages.includes(expectedPackage)) {
    return {
      ok: false,
      reason: `google-services.json has no client for package ${expectedPackage} (it has: ${packages.join(", ") || "none"})`,
    };
  }
  const client = clients.find((c) => c?.client_info?.android_client_info?.package_name === expectedPackage);
  const keys = (client.api_key || []).map((k) => String(k.current_key || ""));
  const placeholder =
    json.project_info?.project_number === "000000000000" ||
    /^qa-placeholder/i.test(json.project_info?.project_id || "") ||
    keys.some((k) => /PLACEHOLDER/i.test(k)) ||
    /0{16,}/.test(client.client_info?.mobilesdk_app_id || "");
  if (placeholder && !allowPlaceholder) {
    return { ok: false, reason: "google-services.json is the local-QA placeholder, not a real Firebase file" };
  }
  return { ok: true, placeholder, project: json.project_info?.project_id };
}

module.exports = { checkGoogleServices };

if (require.main === module) {
  const args = process.argv.slice(2);
  const allowPlaceholder = args.includes("--allow-placeholder");
  const rest = args.filter((a) => a !== "--allow-placeholder");
  const copy = rest[0] === "--copy";
  const [src, a, b] = copy ? rest.slice(1) : rest;
  const expectedPackage = copy ? b : a;
  const result = checkGoogleServices(src, expectedPackage, { allowPlaceholder });
  if (!result.ok) {
    console.error(`google-services check FAILED: ${result.reason}`);
    process.exit(1);
  }
  if (copy) fs.copyFileSync(src, a);
  console.log(`google-services check ok for ${expectedPackage} (project ${result.project}${result.placeholder ? ", PLACEHOLDER allowed" : ""})${copy ? `; copied to ${a}` : ""}`);
}
