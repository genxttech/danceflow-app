#!/usr/bin/env node
// Marketing M-0: verify that a deployment can serve as the application ROLLBACK TARGET (docs/marketing/m0-email-compliance.md §6).
//
//   node scripts/m0-rollback-build-smoke.mjs <deployment-base-url>
//
// Read-only. It uses a freshly generated random token, which matches no recipient, so nothing is recorded anywhere. It
// sends no email and needs no credentials. It passes only when the deployment:
//   1. answers an RFC 8058 one-click POST to /api/email/unsubscribe/<token> with 200 and no redirect -- a plain pre-M-0
//      build has no such endpoint (404) and is rejected, so it can never be selected as the rollback target;
//   2. answers GET on that URL with a redirect to the confirmation page (GET never unsubscribes);
//   3. renders the studio confirmation page /unsubscribe/marketing/<token>;
//   4. renders the organizer confirmation page /unsubscribe/organizer-marketing/<token>.
// The endpoint needs M-0 stage 1 in the database the deployment uses. Before PROD stage 1, verify the rollback build's
// exact source SHA against a DEV-backed (stage 1) preview of that SHA; see the runbook.
import { randomUUID } from "node:crypto";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+/.test(base)) {
  console.error("usage: node scripts/m0-rollback-build-smoke.mjs <deployment-base-url>");
  process.exit(2);
}

const token = randomUUID();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

async function main() {
  const oneClick = await fetch(`${base}/api/email/unsubscribe/${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
  });
  check("one-click POST answers 200", oneClick.status === 200, `status ${oneClick.status}`);
  check("one-click POST does not redirect", !oneClick.headers.get("location"), oneClick.headers.get("location") ?? "");

  const get = await fetch(`${base}/api/email/unsubscribe/${token}`, { redirect: "manual" });
  const location = get.headers.get("location") ?? "";
  check("GET only redirects to the confirmation page", get.status === 303 && location.includes(`/unsubscribe/marketing/${token}`), `status ${get.status} ${location}`);

  const studio = await fetch(`${base}/unsubscribe/marketing/${token}`, { redirect: "manual" });
  const studioHtml = studio.status === 200 ? await studio.text() : "";
  check("studio confirmation page renders", studio.status === 200 && studioHtml.includes("Unsubscribe from marketing emails?"), `status ${studio.status}`);

  const organizer = await fetch(`${base}/unsubscribe/organizer-marketing/${token}`, { redirect: "manual" });
  const organizerHtml = organizer.status === 200 ? await organizer.text() : "";
  const organizerRendered =
    organizerHtml.includes("Unsubscribe from marketing emails?") || // M-0 confirmation page
    organizerHtml.includes("Unsubscribe link not found"); // pre-M-0 page for an unknown token (renders, records nothing)
  check("organizer confirmation page renders", organizer.status === 200 && organizerRendered, `status ${organizer.status}`);

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `ROLLBACK TARGET VERIFIED: ${base}` : `NOT A VALID ROLLBACK TARGET: ${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`NOT A VALID ROLLBACK TARGET: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
