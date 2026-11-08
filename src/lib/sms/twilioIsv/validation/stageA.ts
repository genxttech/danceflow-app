import "server-only";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ReadOnlyProbe, type ProbeFetch, type StageAReport } from "./probe";

/**
 * Stage A entry point (called by scripts/tw4-validation/stage-a.ts). Pure over its inputs so it can be tested with an injected fetch:
 * it reads credentials from the environment it is given, requires an explicit confirmation flag, runs the read-only probe and returns the
 * report as text. It never writes files itself and never prints credentials.
 *
 * Exit codes: 0 = probe completed with no problems; 1 = probe ran but reported problems (a report is still written); 2 = REFUSED before
 * any request was sent (nothing was contacted). Every refusal says what to correct.
 *
 * Credentials: TWILIO_ACCOUNT_SID plus TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET (a temporary, revocable Standard key). The master
 * TWILIO_AUTH_TOKEN is used only with the explicit --use-auth-token flag, and never together with a key. Optional: TWILIO_ISV_PRIMARY_PROFILE_SID, TWILIO_ISV_{PRIMARY,SECONDARY,A2P}_POLICY_SID, TW4_VALIDATION_EXPECTED_NAME,
 * TW4_VALIDATION_EXPECTED_EIN (compared with the Primary profile, never printed).
 */

export const STAGE_A_CONFIRM_FLAG = "--confirm-stage-a-read-only";
export const SELF_TEST_FLAG = "--self-test";
/** The master auth token is used ONLY when this flag is passed explicitly; an ambient TWILIO_AUTH_TOKEN is never picked up silently. */
export const USE_AUTH_TOKEN_FLAG = "--use-auth-token";

const SID = (prefix: string) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`);
// The Primary ISV profile named in the TW-4 design (GenX TotalTech LLC). A SID, not a secret.
export const DEFAULT_PRIMARY_PROFILE_SID = "BUed777b1ed81df271793fbd097324ec94";

export type StageAOutcome = { ok: true; exitCode: 0 | 1; text: string; problems: string[]; hints: string[]; notRun: { section: string; reason: string }[] } | { ok: false; exitCode: 2; text: string };

/** A refusal always says that nothing was sent, what is wrong, and what to do. */
export function refusal(what: string, fix: string): { ok: false; exitCode: 2; text: string } {
  return { ok: false, exitCode: 2, text: `REFUSED (exit code 2), nothing was sent to Twilio.\n  Problem: ${what}\n  To fix:  ${fix}\n` };
}

export type OutPathCheck = { ok: true; path: string | null } | { ok: false; exitCode: 2; text: string };

/** Validates --out BEFORE any request: a bad path must not be discovered after the probe ran. */
export function checkOutPath(argv: string[]): OutPathCheck {
  const index = argv.indexOf("--out");
  if (index < 0) return { ok: true, path: null };
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return refusal("--out was given without a file path.", "pass --out <new file path>, for example --out C:\\Users\\you\\AppData\\Local\\Temp\\tw4-stage-a-2.json");
  if (existsSync(value)) {
    return refusal(
      `the report file already exists: ${value}\n           Stage A never overwrites a report, so the earlier report is still there and was NOT updated.`,
      "choose a NEW file name for --out (the launcher does this for you with a timestamped name), or delete/rename the old report first.",
    );
  }
  const dir = dirname(value);
  let dirOk = false;
  try {
    dirOk = statSync(dir).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) return refusal(`the folder for --out does not exist: ${dir}`, "create the folder first or choose a path in an existing folder.");
  return { ok: true, path: value };
}

/** Plain-language explanations for the problems a probe can report. Never contains secrets or Twilio free text. */
export function hintsFor(problems: string[]): string[] {
  const hints = new Set<string>();
  for (const problem of problems) {
    const code = /code (\d+)/.exec(problem)?.[1];
    const codeText = code ? ` (code ${code})` : "";
    if (/http 401/.test(problem)) {
      if (problem.startsWith("account:")) {
        hints.add(`The Accounts endpoint answered 401${codeText}. Twilio documents that a Standard API key cannot access the Accounts resource (only a Main key or the Account SID + Auth Token can), so with a Standard key this answer does NOT mean the key is wrong. The probe skips that endpoint for API keys; if you see this with the auth token, the token or Account SID is wrong.`);
      } else {
        hints.add(`Twilio rejected the credentials on a read a Standard key is allowed to make (401${codeText}). Check: the key was created in the same Twilio account that owns the Primary profile and in the US1 region, is not revoked, and its secret is complete. If all of that is right, this API may not accept the key: report this line; do not switch credentials without a separate decision.`);
      }
    }
    if (/http 403/.test(problem)) hints.add("Twilio refused this key for that endpoint (403). A Standard key should read these resources; a Restricted key may need read access to Trust Hub and Messaging.");
    if (/http 404/.test(problem)) hints.add("Twilio did not find a resource (404). Check TWILIO_ISV_PRIMARY_PROFILE_SID and that the credentials belong to the account that owns the Primary profile.");
    if (/transient/.test(problem)) hints.add("A network error or Twilio-side error occurred. Rerun once; if it repeats, report the exact problem line.");
  }
  return [...hints];
}

export async function executeStageA(input: { argv: string[]; env: Record<string, string | undefined>; fetchImpl: ProbeFetch; selfTest?: boolean }): Promise<StageAOutcome> {
  if (!input.argv.includes(STAGE_A_CONFIRM_FLAG)) {
    return refusal("the confirmation flag is missing.", `add ${STAGE_A_CONFIRM_FLAG} (it confirms this is the read-only Stage A probe: GET requests to Twilio only).`);
  }
  const env = input.env;
  const accountSid = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
  if (!accountSid) return refusal("TWILIO_ACCOUNT_SID is not set.", "set the Account SID (AC followed by 32 hex characters), or use the launcher, which prompts for it.");
  if (!SID("AC").test(accountSid)) return refusal(`TWILIO_ACCOUNT_SID is malformed (length ${accountSid.length}, starts "${accountSid.slice(0, 2)}").`, "it must be AC followed by 32 hex characters (34 characters in all).");
  const keySid = String(env.TWILIO_API_KEY_SID ?? "").trim();
  const keySecret = String(env.TWILIO_API_KEY_SECRET ?? "");
  const token = String(env.TWILIO_AUTH_TOKEN ?? "");
  let auth: { username: string; password: string };
  let authMethod: "api_key" | "auth_token";
  const tokenRequested = input.argv.includes(USE_AUTH_TOKEN_FLAG);
  if ((keySid || keySecret) && (token || tokenRequested)) {
    return refusal("both an API key and the master auth token are present, so the credential type is ambiguous.", "unset TWILIO_AUTH_TOKEN (and do not pass --use-auth-token) to use the API key, or unset the API key variables to use the token deliberately.");
  }
  if (keySid || keySecret) {
    if (!keySid) return refusal("TWILIO_API_KEY_SECRET is set but TWILIO_API_KEY_SID is not.", "set the API key SID (SK followed by 32 hex characters).");
    if (!SID("SK").test(keySid)) return refusal(`TWILIO_API_KEY_SID is malformed (length ${keySid.length}, starts "${keySid.slice(0, 2)}").`, "it must be SK followed by 32 hex characters (34 characters in all); AC is the Account SID, not the key SID.");
    if (!keySecret) return refusal("TWILIO_API_KEY_SECRET is not set.", "set the API key secret (shown once when the key was created).");
    auth = { username: keySid, password: keySecret };
    authMethod = "api_key";
  } else if (tokenRequested) {
    if (!token) return refusal(`${USE_AUTH_TOKEN_FLAG} was passed but TWILIO_AUTH_TOKEN is not set.`, "set TWILIO_AUTH_TOKEN, or drop the flag and use an API key.");
    auth = { username: accountSid, password: token };
    authMethod = "auth_token";
  } else if (token) {
    return refusal("TWILIO_AUTH_TOKEN is set but token authentication was not requested.", `Stage A uses an API key by default and never falls back to the master token on its own. Unset TWILIO_AUTH_TOKEN, or pass ${USE_AUTH_TOKEN_FLAG} to use it deliberately.`);
  } else {
    return refusal("no credentials were provided.", "set TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET.");
  }
  const primaryProfileSid = String(env.TWILIO_ISV_PRIMARY_PROFILE_SID ?? DEFAULT_PRIMARY_PROFILE_SID).trim();
  if (!SID("BU").test(primaryProfileSid)) return refusal("TWILIO_ISV_PRIMARY_PROFILE_SID is malformed.", "it must be BU followed by 32 hex characters, or leave it unset to use the GenX Primary profile from the design.");
  const policy = (name: string) => {
    const value = String(env[name] ?? "").trim();
    return SID("RN").test(value) ? value : undefined;
  };
  const report: StageAReport = await new ReadOnlyProbe(auth, input.fetchImpl).run({
    accountSid,
    authMethod,
    primaryProfileSid,
    configuredPolicies: { primary: policy("TWILIO_ISV_PRIMARY_POLICY_SID"), secondary: policy("TWILIO_ISV_SECONDARY_POLICY_SID"), a2p: policy("TWILIO_ISV_A2P_POLICY_SID") },
    expectedLegalName: String(env.TW4_VALIDATION_EXPECTED_NAME ?? "").trim() || undefined,
    expectedEin: String(env.TW4_VALIDATION_EXPECTED_EIN ?? "").trim() || undefined,
  });
  const hints = hintsFor(report.problems);
  const clean = report.account.ok !== false && report.problems.length === 0;
  const body = { selfTest: input.selfTest === true, authMethod, ...report, hints };
  return { ok: true, exitCode: clean ? 0 : 1, text: `${JSON.stringify(body, null, 2)}\n`, problems: report.problems, hints, notRun: report.notRun };
}
