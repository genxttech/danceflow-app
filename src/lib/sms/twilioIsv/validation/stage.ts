import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fakeAdapterAllowed, realCallsAllowed, type IsvConfig } from "../config";
import { isLoopbackUrl } from "../loopback";
import { classifyEvaluation, runBrandSubmission, safeFieldNames, type RunResult } from "../runner";
import type { RunnerStore } from "../store";
import { ISV_STEP_KEYS, type IsvAdapter } from "../types";

/**
 * TW-4 mock-brand validation, STAGES B and C: a guarded wrapper around the production runner for a controlled run on ONE non-pilot
 * test studio in a LOCAL database. It adds no new capability: the runner, its ledger, its fee gate and the database window still decide
 * everything. What it adds is the operator-side fence:
 *
 *   B  steps S1-S10 only (draft Secondary profile, EndUsers, address, document, assignments, profile EVALUATION). Nothing is submitted for
 *      Twilio review, no fee step can run (confirmFee is false and the step list stops before it).
 *   C  the rest (S11 submit profile, T1-T6 trust product, B1 brand) and ONLY as a Twilio MOCK brand: refused unless config.mockBrand is on.
 *
 * Guards (all must hold, nothing is configurable around them): the studio is named twice (typed confirmation); it is not on the forbidden
 * list (ConfiDance); the database is loopback; the adapter is the fake (non-production, loopback, TW4_ISV_FAKE) or the real one behind the
 * runner's own production + TW4_ISV_REAL_CALLS gate; the window is 1-2 hours and is ALWAYS closed again, success or failure.
 */

export type StageName = "B" | "C";
export const STAGE_B_LAST_STEP = "S10" as const; // S11 submits the profile for review and belongs to stage C. Positional: a re-run or resume can never go past it.

export type StageGuardInput = {
  stage: StageName;
  studioId: string;
  confirmStudioId: string;
  forbiddenStudioIds: string[];
  supabaseUrl: string;
  adapterKind: "fake" | "real";
  config: IsvConfig;
  windowHours: number;
  env: Record<string, string | undefined>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const loopbackUrl = isLoopbackUrl;

export function checkStageGuards(input: StageGuardInput): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (input.stage !== "B" && input.stage !== "C") return refuse("unknown stage");
  if (!UUID.test(input.studioId)) return refuse("studio id is not a uuid");
  if (input.confirmStudioId.trim().toLowerCase() !== input.studioId.toLowerCase()) return refuse("the typed studio confirmation does not match the studio id");
  const hex = (value: string) => value.trim().replace(/^urn:uuid:/i, "").replace(/[{}-]/g, "").toLowerCase();
  if (input.forbiddenStudioIds.some((id) => hex(id) === hex(input.studioId))) return refuse("this studio is on the forbidden list (pilot studios are never used for validation)");
  if (!loopbackUrl(input.supabaseUrl)) return refuse("the database is not a loopback (local) database");
  if (!Number.isInteger(input.windowHours) || input.windowHours < 1 || input.windowHours > 2) return refuse("the window must be 1 or 2 hours");
  if (input.stage === "C" && !input.config.mockBrand) return refuse("stage C only runs as a Twilio MOCK brand (TW4_ISV_MOCK_BRAND=on)");
  if (input.stage === "B" && input.config.mockBrand === false && input.adapterKind === "real") {
    // stage B never reaches the brand step, but a mock run should say so explicitly so a later stage C cannot start un-flagged
    return refuse("set TW4_ISV_MOCK_BRAND=on for every validation stage so no stage can ever be a paid brand run");
  }
  if (input.adapterKind === "fake") {
    if (!fakeAdapterAllowed(input.env)) return refuse("the fake adapter is not allowed here (needs TW4_ISV_FAKE=on, a non-production environment and a loopback database)");
  } else {
    const gate = realCallsAllowed(input.env);
    if (!gate.allowed) return refuse(gate.reason);
    // The validation harness signs with a Standard API key only. The master auth token is not permitted here (decision D1): the config
    // loader leaves authToken empty whenever a key is configured, and a config that still carries a token is refused.
    if (!input.config.apiKeySid || !input.config.apiKeySecret) return refuse("the validation harness requires a Standard API key (TWILIO_ISV_API_KEY_SID and TWILIO_ISV_API_KEY_SECRET); the auth token is not permitted");
    if (input.config.authToken) return refuse("the configuration carries an auth token as well as an API key; the validation harness never uses the auth token");
  }
  return { ok: true };
}

/**
 * Records which adapter methods ran and how they ended; never arguments or results (those can hold business data or the EIN). The one
 * exception is an evaluation: its sanitized verdict (status + failing Twilio field NAMES) is recorded in `evaluations`.
 */
export function recordingAdapter(inner: IsvAdapter): { adapter: IsvAdapter; calls: { method: string; ok: boolean; errorKind?: string }[]; evaluations: EvaluationRecord[] } {
  const calls: { method: string; ok: boolean; errorKind?: string }[] = [];
  const evaluations: EvaluationRecord[] = [];
  const adapter = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return async (...args: unknown[]) => {
        try {
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          calls.push({ method: prop, ok: true });
          if (prop === "evaluateCustomerProfile" || prop === "evaluateTrustProduct") evaluations.push(sanitizedEvaluation(prop, result));
          return result;
        } catch (error) {
          calls.push({ method: prop, ok: false, errorKind: String((error as { kind?: string }).kind ?? "error") });
          throw error;
        }
      };
    },
  });
  return { adapter, calls, evaluations };
}

/** What an evaluation call established, with only the Twilio field NAMES that failed (never a value, never the request). */
export type EvaluationRecord = {
  method: "evaluateCustomerProfile" | "evaluateTrustProduct";
  evaluationSid: string | null;
  status: "compliant" | "noncompliant" | "unrecognized";
  failedFields: string[];
};

export function sanitizedEvaluation(method: EvaluationRecord["method"], reply: unknown): EvaluationRecord {
  const body = reply !== null && typeof reply === "object" ? (reply as { evaluationSid?: unknown; result?: unknown }) : {};
  const verdict = classifyEvaluation(body.result);
  const sid = typeof body.evaluationSid === "string" && /^EL[0-9a-fA-F]{32}$/.test(body.evaluationSid) ? body.evaluationSid : null;
  return { method, evaluationSid: sid, status: verdict.kind, failedFields: safeFieldNames(verdict.failedFields) };
}

/* ---- Stage C authorization: an executable gate, not a label ------------------------------------------------------------------ */

export type LedgerRow = { step_key: string; status: string; provider_sid: string | null; seq: number };
export type StageCAuthorization = { token: string; expiresAt: string };

const STAGE_B_KEYS: readonly string[] = ISV_STEP_KEYS.slice(0, ISV_STEP_KEYS.indexOf(STAGE_B_LAST_STEP) + 1);
const MAX_AUTH_MINUTES = 240;

/** The ledger rows of the newest submission: the generation whose S1..S10 a stage C token must name. */
function latestGeneration(ledger: LedgerRow[]): LedgerRow[] {
  const seq = ledger.reduce((max, row) => Math.max(max, row.seq), 0);
  return ledger.filter((row) => row.seq === seq);
}

function stageBSids(ledger: LedgerRow[]): { complete: boolean; sids: string[] } {
  const rows = latestGeneration(ledger);
  const sids = STAGE_B_KEYS.map((key) => rows.find((row) => row.step_key === key && row.status === "succeeded")?.provider_sid ?? "");
  return { complete: sids.every(Boolean), sids };
}

/** Fields every stage authorization binds besides the studio and expiry: the Primary profile, the compliance mailbox and the API key SID. */
function bindingOf(config: IsvConfig): string[] {
  return [config.primaryProfileSid, config.complianceEmail.toLowerCase(), config.apiKeySid ?? ""];
}

/** HMAC over a JSON array (unambiguous: no delimiter that a field value could contain). */
function mac(secret: string, parts: unknown[]): string {
  return createHmac("sha256", secret).update(JSON.stringify(parts)).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/i;
/** Exactly 64 hex characters or nothing: Buffer.from(...,"hex") would otherwise silently truncate trailing garbage. */
function tokenBytes(token: string): Buffer | null {
  return HEX64.test(token) ? Buffer.from(token, "hex") : null;
}
const MIN_SECRET = 16;

/**
 * HMAC over the studio, the expiry, the mock switch, the Primary profile, the compliance mailbox, the API key SID and the Twilio SIDs
 * that stage B produced. The secret is the throwaway local key written by `seed` and deleted by `cleanup`, so a token cannot outlive its
 * seed, cannot be reused for another studio, expiry, mailbox, key or set of stage B resources, and cannot be computed without running
 * `authorize-c` on this machine.
 */
export function stageCToken(secret: string, input: { studioId: string; expiresAt: string; mock: boolean; sids: string[]; config: IsvConfig }): string {
  return mac(secret, ["tw4-stage-c", input.studioId.toLowerCase(), input.expiresAt, input.mock ? "mock" : "paid", ...bindingOf(input.config), input.sids]);
}

export function issueStageCAuthorization(input: { secret: string; studioId: string; ledger: LedgerRow[]; config: IsvConfig; minutes: number; now?: Date }): { ok: true; authorization: StageCAuthorization } | { ok: false; reason: string } {
  if (input.secret.length < MIN_SECRET) return { ok: false, reason: "the local authorization secret is missing" };
  if (!input.config.mockBrand) return { ok: false, reason: "stage C is only ever authorized as a MOCK brand" };
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_AUTH_MINUTES) return { ok: false, reason: `the authorization lifetime must be 1-${MAX_AUTH_MINUTES} minutes` };
  const b = stageBSids(input.ledger);
  if (!b.complete) return { ok: false, reason: "stage B (S1-S10) has not completed for this studio" };
  const expiresAt = new Date((input.now ?? new Date()).getTime() + input.minutes * 60_000).toISOString();
  return { ok: true, authorization: { expiresAt, token: stageCToken(input.secret, { studioId: input.studioId, expiresAt, mock: true, sids: b.sids, config: input.config }) } };
}

export function verifyStageCAuthorization(input: { secret: string; studioId: string; ledger: LedgerRow[]; config: IsvConfig; authorization: StageCAuthorization | undefined; now?: Date }): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.authorization) return refuse("stage C needs its own authorization: run `authorize-c` after reading the stage B report, then pass --stage-c-token and --stage-c-expires");
  if (input.secret.length < MIN_SECRET) return refuse("the local authorization secret is missing");
  if (!input.config.mockBrand) return refuse("stage C is only ever authorized as a MOCK brand");
  const expires = Date.parse(input.authorization.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(expires) || expires <= now) return refuse("the stage C authorization has expired");
  if (expires > now + MAX_AUTH_MINUTES * 60_000) return refuse("the stage C authorization lifetime is too long");
  const b = stageBSids(input.ledger);
  if (!b.complete) return refuse("stage B (S1-S10) has not completed for this studio");
  const given = tokenBytes(input.authorization.token);
  if (!given) return refuse("the stage C authorization token is malformed");
  const expected = Buffer.from(stageCToken(input.secret, { studioId: input.studioId, expiresAt: input.authorization.expiresAt, mock: true, sids: b.sids, config: input.config }), "hex");
  if (!timingSafeEqual(given, expected)) return refuse("the stage C authorization token does not match this studio, mailbox, key and its stage B resources");
  return { ok: true };
}

/* ---- Stage B authorization (real adapter only): the first stage that WRITES to Twilio is also an executable gate ------------------ */

export type StageBAuthorization = { token: string; expiresAt: string };
const MAX_STAGE_B_MINUTES = 120;

export function stageBToken(secret: string, config: IsvConfig, studioId: string, expiresAt: string): string {
  return mac(secret, ["tw4-stage-b", studioId.toLowerCase(), expiresAt, config.mockBrand ? "mock" : "paid", ...bindingOf(config)]);
}

export function issueStageBAuthorization(input: { secret: string; studioId: string; config: IsvConfig; minutes: number; now?: Date }): { ok: true; authorization: StageBAuthorization } | { ok: false; reason: string } {
  if (input.secret.length < MIN_SECRET) return { ok: false, reason: "the local authorization secret is missing" };
  if (!input.config.mockBrand) return { ok: false, reason: "validation stages are only ever authorized with the mock-brand switch on" };
  if (!input.config.apiKeySid) return { ok: false, reason: "no Standard API key is configured" };
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > MAX_STAGE_B_MINUTES) return { ok: false, reason: `the authorization lifetime must be 1-${MAX_STAGE_B_MINUTES} minutes` };
  const expiresAt = new Date((input.now ?? new Date()).getTime() + input.minutes * 60_000).toISOString();
  return { ok: true, authorization: { expiresAt, token: stageBToken(input.secret, input.config, input.studioId, expiresAt) } };
}

export function verifyStageBAuthorization(input: { secret: string; studioId: string; config: IsvConfig; authorization: StageBAuthorization | undefined; now?: Date }): { ok: true } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (!input.authorization) return refuse("stage B with the real adapter needs its own authorization: run `authorize-b`, then pass --stage-b-token and --stage-b-expires");
  if (input.secret.length < MIN_SECRET) return refuse("the local authorization secret is missing");
  const expires = Date.parse(input.authorization.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(expires) || expires <= now) return refuse("the stage B authorization has expired");
  if (expires > now + MAX_STAGE_B_MINUTES * 60_000) return refuse("the stage B authorization lifetime is too long");
  const given = tokenBytes(input.authorization.token);
  if (!given) return refuse("the stage B authorization token is malformed");
  const expected = Buffer.from(stageBToken(input.secret, input.config, input.studioId, input.authorization.expiresAt), "hex");
  if (!timingSafeEqual(given, expected)) return refuse("the stage B authorization token does not match this studio, mailbox, key and Primary profile");
  return { ok: true };
}

export type StageReport = {
  stage: StageName;
  studioId: string;
  adapterKind: "fake" | "real";
  mockBrand: boolean;
  windowHours: number;
  windowClosed: boolean;
  result: RunResult;
  state: string | null;
  brandStatus: string | null;
  einOnFile: boolean | null;
  ledger: { step: string; status: string; feeBearing: boolean; feeConfirmed: boolean; errorCode: string | null }[];
  adapterCalls: { method: string; ok: boolean; errorKind?: string }[];
  /** The actual evaluation verdicts (S10 profile, T5 trust product): status plus failing Twilio field names only. Empty if no evaluation ran. */
  evaluations: EvaluationRecord[];
};

export async function runValidationStage(input: {
  guard: StageGuardInput;
  store: RunnerStore;
  adapter: IsvAdapter;
  actorId: string;
  decrypt?: (studioId: string, ciphertext: string) => string;
  /** Reads the studio's provisioning ledger (all generations). Required: the stage preconditions are decided from it. */
  readLedger: () => Promise<LedgerRow[]>;
  /** Required for stage C: the secret and the authorization produced by `authorize-c`. */
  stageC?: { secret: string; authorization: StageCAuthorization | undefined };
  /** Required for stage B with the REAL adapter: the secret and the authorization produced by `authorize-b`. */
  stageB?: { secret: string; authorization: StageBAuthorization | undefined };
}): Promise<{ ok: true; report: StageReport } | { ok: false; reason: string }> {
  const guard = checkStageGuards(input.guard);
  if (!guard.ok) return guard;
  const { stage, studioId, config, windowHours } = input.guard;
  // Preconditions are decided from the ledger BEFORE a window is opened or an adapter is touched.
  let ledger: LedgerRow[];
  try {
    ledger = await input.readLedger();
  } catch {
    return { ok: false, reason: "the provisioning ledger could not be read" };
  }
  if (stage === "B") {
    if (input.guard.adapterKind === "real") {
      if (!input.stageB) return { ok: false, reason: "stage B with the real adapter needs its own authorization (see authorize-b)" };
      const verified = verifyStageBAuthorization({ secret: input.stageB.secret, studioId, config, authorization: input.stageB.authorization });
      if (!verified.ok) return verified;
    }
    const later = ledger.filter((row) => !STAGE_B_KEYS.includes(row.step_key));
    if (later.length > 0) return { ok: false, reason: "stage B will not run: the ledger already has steps after S10 (S11 or later has been started for this studio)" };
  } else {
    if (!input.stageC) return { ok: false, reason: "stage C needs its own authorization (see authorize-c)" };
    const verified = verifyStageCAuthorization({ secret: input.stageC.secret, studioId, ledger, config, authorization: input.stageC.authorization });
    if (!verified.ok) return verified;
  }
  const recorded = recordingAdapter(input.adapter);
  await input.store.setWindow(studioId, input.actorId, windowHours, `tw4 validation stage ${stage}`);
  let result: RunResult;
  let windowClosed = false;
  try {
    result = await runBrandSubmission({
      store: input.store,
      adapter: recorded.adapter,
      config,
      studioId,
      actorId: input.actorId,
      confirmFee: stage === "C",
      // Stage C is the submission stage: its own authorization token (checked above) is the explicit confirmation of both submissions.
      confirmSubmit: stage === "C" ? ["S11", "T6"] : undefined,
      // Stage C is one authorized pass over S11..B1 after the owner read the Stage B report: the same-run rule is lifted for it alone.
      allowSubmitInSameRunAsEvaluation: stage === "C",
      stopAfter: stage === "B" ? STAGE_B_LAST_STEP : undefined,
      decrypt: input.decrypt,
    });
  } finally {
    try {
      await input.store.setWindow(studioId, input.actorId, 0, `tw4 validation stage ${stage} finished`);
      windowClosed = true;
    } catch {
      windowClosed = false; // reported below; the database expiry still closes it
    }
  }
  const status = await input.store.status(studioId, input.actorId).catch(() => null);
  return {
    ok: true,
    report: {
      stage,
      studioId,
      adapterKind: input.guard.adapterKind,
      mockBrand: config.mockBrand,
      windowHours,
      windowClosed,
      result,
      state: status?.state ?? null,
      brandStatus: status?.brand_status ?? null,
      einOnFile: status ? status.ein_on_file : null,
      ledger: (status?.steps ?? []).map((row) => ({ step: row.step_key, status: row.status, feeBearing: row.fee_bearing, feeConfirmed: row.fee_confirmed, errorCode: row.error_code })),
      adapterCalls: recorded.calls,
      evaluations: recorded.evaluations,
    },
  };
}
