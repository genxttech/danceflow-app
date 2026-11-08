import "server-only";
import type { ProbeFetch } from "./probe";

/**
 * Canned Twilio responses for `stage-a.ts --self-test` and the PowerShell launcher's dry run. There is NO network access in this file:
 * it answers the exact read-only URLs the probe uses with made-up data, so the whole launcher + CLI + report path can be exercised without
 * contacting Twilio. Reports produced this way carry `"selfTest": true` and contain only the data below.
 */
const PRIMARY = "BUed777b1ed81df271793fbd097324ec94";
const EU = `IT${"a".repeat(32)}`;

export const selfTestFetch: ProbeFetch = async (url, init) => {
  if (init.method !== "GET") throw new Error("self-test fetch: GET only");
  const body = (value: unknown) => ({ status: 200, text: async () => JSON.stringify(value) });
  const u = new URL(url);
  if (u.hostname === "api.twilio.com" && u.pathname.includes("/Accounts/")) return body({ status: "active", type: "Full" });
  if (u.pathname === `/v1/CustomerProfiles/${PRIMARY}`) return body({ sid: PRIMARY, status: "twilio-approved", policy_sid: `RN${"4".repeat(32)}` });
  if (u.pathname === `/v1/CustomerProfiles/${PRIMARY}/EntityAssignments`) return body({ results: [{ object_sid: EU }], meta: {} });
  if (u.pathname === `/v1/EndUsers/${EU}`) {
    return body({ sid: EU, type: "customer_profile_business_information", attributes: { business_name: "Self Test LLC", business_type: "Limited Liability Company", business_identity: "isv_reseller_or_partner", business_industry: "TECHNOLOGY", business_registration_identifier: "EIN", business_registration_number: "000000000" } });
  }
  if (u.pathname === "/v1/Policies") return body({ results: [{ sid: `RN${"4".repeat(32)}`, friendly_name: "Self-test primary policy" }], meta: {} });
  if (u.pathname === "/v1/CustomerProfiles" || u.pathname === "/v1/TrustProducts") return body({ results: [], meta: {} });
  if (u.pathname === "/v1/a2p/BrandRegistrations") return body({ data: [], meta: {} });
  return { status: 404, text: async () => JSON.stringify({ code: 20404, message: "self-test: unknown url" }) };
};
