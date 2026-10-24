"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { ProviderFeeLifecycleStore, type CancelDecision } from "@/lib/sms/providerFeeLifecycle";
import { loadExposureReport, loadRecurringFeeOps, ProviderFeeOpsStore, RFL_FLASH_COOKIE, type DualAction } from "@/lib/sms/providerFeeOps";
import { encodePanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import { cancelReleaseRuntime } from "@/lib/sms/twilioIsv/cancelRuntime";
import { APPROVAL_REF_MAX, APPROVAL_REF_MIN, approvalRefInRange, usdToCents, validatePilotEvidence } from "@/lib/sms/pilotApprovalEvidence";

/**
 * TW-4F recurring provider fees: platform-administrator operations. Every action runs `requirePlatformAdmin()` FIRST, takes the ACTOR from the session
 * (never from the form), validates its inputs, and only then builds a service-role client. The database checks the platform-admin actor again, enforces
 * dual control (a requester can never approve their own request) and every state rule. Database error text is never shown: SQLSTATEs map to fixed
 * sentences. Nothing here calls Twilio except `rflCancelReleaseAction` (TW-4F F5), and that only through the cancellation runner when its runtime is
 * switched on and installed; otherwise a cancellation is authorized and evidenced here, and the console step is a human's.
 */

const RETURN_PATH = "/platform/sms";
const ANCHOR = "#recurring-fees";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

type Flash = { ok: boolean; message: string };
const fail = (message: string): Flash => ({ ok: false, message });
const done = (message: string): Flash => ({ ok: true, message });

const ERRORS: Record<string, string> = {
  "42501": "Not allowed. Only a platform administrator can do this, and a request can never be approved by the administrator who made it. Nothing changed.",
  "22023": "The database refused the input (check the lengths, the period and the references). Nothing changed.",
  TW052: "The approval evidence was refused: the date, the authorizing role, the scope, the amount (it must equal the published price), the period, the document reference and its sha256 must all be present and consistent. Nothing changed.",
  TW007: "The credit account is on hold, negative or the pilot ceiling would be exceeded. Nothing changed.",
  TW008: "No published price exists for this fee, or the authorized amount does not equal it. Nothing changed.",
  TW041: "This is not allowed in the resource's current state. Nothing changed.",
  TW042: "The required approval is missing or does not match (business, resource, period, reference and reason must be identical), or the period is outside the allowed window. Nothing changed.",
  TW043: "The record was refused: the evidence digest must be 64 lowercase hex characters, a refusal needs the error code api, or this period/operation is already recorded. Nothing changed.",
  TW019: "That written reference is already used for another decision. Use a new reference. Nothing changed.",
  TW010: "This location is not linked to a business, so the action cannot be applied. Nothing changed.",
  "42883": "This operation is not available in this environment yet. Nothing changed.",
  PGRST202: "This operation is not available in this environment yet. Nothing changed.",
};

function describeError(e: unknown): string {
  const code = e && typeof e === "object" ? String((e as { code?: unknown }).code ?? "") : "";
  return ERRORS[code] ?? "The action failed. Nothing changed; reload and check the current state before trying again.";
}

function field(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}
function text(form: FormData, name: string, min: number, max: number): string | null {
  const v = field(form, name);
  return v.length >= min && v.length <= max ? v : null;
}
function id(form: FormData, name: string): string | null {
  const v = field(form, name);
  return UUID.test(v) ? v : null;
}
const checked = (form: FormData, name: string) => ["on", "yes", "true", "1"].includes(field(form, name).toLowerCase());

/** Back to the panel with the result. The text goes in a short-lived httpOnly cookie, never the URL (a crafted link cannot show a fake result). */
async function finish(result: Flash): Promise<never> {
  revalidatePath(RETURN_PATH);
  (await cookies()).set(RFL_FLASH_COOKIE, encodePanelFlash(result), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: 60,
  });
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "rfl" : "rfl_error"}=1${ANCHOR}`);
}

/** Validation first, then the service-role client, then the call. A thrown error becomes a fixed sentence. */
async function guarded(work: (admin: { id: string }) => Promise<Flash>): Promise<never> {
  const admin = await requirePlatformAdmin();
  let result: Flash;
  try {
    result = await work(admin);
  } catch (e) {
    result = fail(describeError(e));
  }
  return finish(result);
}

const ops = () => new ProviderFeeOpsStore(createAdminClient());
const lifecycle = () => new ProviderFeeLifecycleStore(createAdminClient());

// ---------------------------------------------------------------------------------------------------------------
// scheduler switches
// ---------------------------------------------------------------------------------------------------------------
export async function rflSetSwitchAction(formData: FormData) {
  await guarded(async (admin) => {
    const sw = field(formData, "switch");
    const enable = field(formData, "enabled");
    const reason = text(formData, "reason", 10, 300);
    if ((sw !== "scan" && sw !== "delivery") || (enable !== "on" && enable !== "off") || !reason) return fail("Choose a switch and give a written reason of 10 to 300 characters. Nothing changed.");
    if (!checked(formData, "confirm")) return fail("Confirm the change first. Nothing changed.");
    const out = await ops().setSwitch(sw, enable === "on", reason, admin.id);
    return done(`The ${sw} switch is now ${out.enabled ? "ON" : "OFF"}. Switches are audited and this does not start any schedule by itself.`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// provider-cost variances (DanceFlow-borne, never charged to a studio)
// ---------------------------------------------------------------------------------------------------------------
export async function rflVarianceAckAction(formData: FormData) {
  await guarded(async (admin) => {
    const chargeId = id(formData, "chargeId");
    const note = text(formData, "note", 10, 500);
    if (!chargeId || !note) return fail("Give an acknowledgement note of 10 to 500 characters. Nothing changed.");
    const out = await ops().varianceAck(chargeId, note, admin.id);
    return done(out.replayed ? "This variance was already acknowledged." : "Acknowledged as a DanceFlow-borne cost. Nothing was charged to any studio.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// dual control
// ---------------------------------------------------------------------------------------------------------------
export async function rflDualRequestAction(formData: FormData) {
  await guarded(async (admin) => {
    const action = field(formData, "action");
    const resourceId = id(formData, "resourceId");
    const reason = text(formData, "reason", 10, 500);
    if ((action !== "absorb_exposure" && action !== "cancel_number") || !resourceId || !reason) return fail("Choose the action and give a written reason of 10 to 500 characters. Nothing changed.");
    let periodKey: string | null = null;
    let approvalRef: string | null = null;
    let decidedBy: "owner_written" | "founder_written" | null = null;
    if (action === "absorb_exposure") {
      periodKey = field(formData, "periodKey");
      if (!PERIOD.test(periodKey)) return fail("A period such as 2026-10 is required. Nothing changed.");
    } else {
      approvalRef = text(formData, "approvalRef", 10, 200);
      if (!approvalRef) return fail("The written approval reference (10 to 200 characters) is required. Nothing changed.");
      const decision = field(formData, "decidedBy");
      if (decision !== "owner_written" && decision !== "founder_written") return fail("Choose who decided in writing: the studio owner or the DanceFlow founder. A number is never cancelled on a policy lapse. Nothing changed.");
      decidedBy = decision;
    }
    await ops().dualRequest({ action: action as DualAction, resourceId, periodKey, reason, approvalRef, decidedBy }, admin.id);
    return done("Request recorded. A different platform administrator must approve it within 24 hours; nothing has been absorbed or cancelled.");
  });
}

export async function rflDualApproveAction(formData: FormData) {
  await guarded(async (admin) => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give an approval note of 10 to 500 characters. Nothing changed.");
    const out = await ops().dualApprove(requestId, note, admin.id);
    if (out.status === "approved") return done("Approved. The approval is single-use, bound to the facts shown, and expires in 24 hours. The action itself is still a separate step.");
    if (out.status === "expired") return fail("The request had expired. Nothing was approved.");
    if (out.status === "invalidated") return fail("The facts changed since the request, so it was invalidated. Nothing was approved; make a new request.");
    return fail("The request was not approved. Reload and check its state.");
  });
}

export async function rflDualRejectAction(formData: FormData) {
  await guarded(async (admin) => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give a note of 10 to 500 characters. Nothing changed.");
    await ops().dualReject(requestId, note, admin.id);
    return done("The request was rejected or withdrawn. Nothing was absorbed or cancelled.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// exposure disposition
// ---------------------------------------------------------------------------------------------------------------
export async function rflDisposeExposureAction(formData: FormData) {
  await guarded(async (admin) => {
    const resourceId = id(formData, "resourceId");
    const periodKey = field(formData, "periodKey");
    const disposition = field(formData, "disposition");
    const note = text(formData, "note", 10, 500);
    if (!resourceId || !PERIOD.test(periodKey) || (disposition !== "absorbed" && disposition !== "not_billed_confirmed") || !note) {
      return fail("Choose a disposition and give a written note of 10 to 500 characters. Nothing changed.");
    }
    if (disposition === "absorbed") {
      // never offered without an approved request; refused here too (the database refuses as well)
      const dual = (await loadRecurringFeeOps(createAdminClient(), admin.id)).dual;
      if (!dual?.some((d) => d.action === "absorb_exposure" && d.status === "approved" && d.resourceId === resourceId && d.periodKey === periodKey)) {
        return fail("Absorbing an exposure needs an approved dual-control request for this resource and period (and the note must be identical to the request's reason). Nothing changed by this submission. If you submitted it a moment ago it may already have been applied: reload and check the exposure before filing a new request.");
      }
    }
    if (disposition === "not_billed_confirmed") {
      // contradictory evidence: a recorded provider bill can only be absorbed (the database refuses as well)
      const exposure = (await loadExposureReport(createAdminClient(), admin.id))?.find((e) => e.resourceId === resourceId && e.periodKey === periodKey);
      if (exposure && exposure.providerBilledCents !== 0) return fail("The provider bill is recorded as evidence for this period, so it cannot be marked as not billed; it can only be absorbed. Nothing changed.");
    }
    await lifecycle().disposeExposure(resourceId, periodKey, disposition, note, admin.id);
    return done(disposition === "absorbed" ? "The exposure was absorbed by DanceFlow. It is never charged to the studio." : "Recorded as confirmed not billed by the provider.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// pilot (ConfiDance) per-period written approval
// ---------------------------------------------------------------------------------------------------------------
export async function rflPilotCoverAction(formData: FormData) {
  await guarded(async (admin) => {
    const resourceId = id(formData, "resourceId");
    const periodKey = field(formData, "periodKey");
    // the ONE shared reference length (pilotApprovalEvidence.ts), checked here before any RPC; the database refuses the same range with errcode 22023
    const approvalRef = approvalRefInRange(field(formData, "approvalRef")) ? field(formData, "approvalRef") : null;
    if (!resourceId || !PERIOD.test(periodKey) || !approvalRef) return fail(`Give the period and a written approval reference of ${APPROVAL_REF_MIN} to ${APPROVAL_REF_MAX} characters. Nothing changed.`);
    if (!checked(formData, "ack")) return fail("Acknowledge that this approval covers one period of one resource and is not a standing authorization. Nothing changed.");
    // U-4: the reference alone is not authorization. The owner's dated written authorization is recorded as evidence (hash and reference only, never the text).
    // The amount is NOT trusted: the database requires it to equal the published price of the fee being covered and refuses otherwise.
    const evidence = validatePilotEvidence({
      authorizedOn: field(formData, "authorizedOn"), authorizedByRole: field(formData, "authorizedByRole"), scope: field(formData, "scope"), amountCents: String(usdToCents(field(formData, "amountUsd")) ?? ""),
      periodKey, documentRef: field(formData, "documentRef"), documentSha256: field(formData, "documentSha256"),
    }, periodKey, Date.now());
    if (!evidence.ok) return fail(`${evidence.message} Nothing changed.`);
    const overview = (await loadRecurringFeeOps(createAdminClient(), admin.id)).overview;
    const resource = overview?.resources.find((r) => r.resourceId === resourceId);
    if (!resource?.pilot || resource.providerState !== "active") return fail("Per-period approvals are only for a live resource of the pilot business. Nothing changed.");
    const out = await lifecycle().pilotCover(resourceId, periodKey, approvalRef, evidence.value, admin.id);
    return done(out.replayed ? "This approval was already recorded." : "Period approval recorded with its evidence. It counts against the cumulative pilot ceiling and does not renew.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// immediate safety suspension (never waits for dual approval; stops DanceFlow sending only)
// ---------------------------------------------------------------------------------------------------------------
export async function rflSuspendAction(formData: FormData) {
  await guarded(async (admin) => {
    const studioId = id(formData, "studioId");
    const reason = text(formData, "reason", 10, 500);
    if (!studioId || !reason) return fail("Choose a location and give a written reason of 10 to 500 characters. Nothing changed.");
    const out = await lifecycle().suspendDanceFlow(studioId, reason, false, admin.id);
    return done(`DanceFlow sending is suspended for this location. Nothing was cancelled or released at Twilio: provider fees continue for ${out.providerFeesContinueFor} resource(s).`);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// controlled cancellation (nothing is cancelled at Twilio by DanceFlow)
// ---------------------------------------------------------------------------------------------------------------
export async function rflCancelAuthorizeAction(formData: FormData) {
  await guarded(async (admin) => {
    const resourceId = id(formData, "resourceId");
    const approvalRef = text(formData, "approvalRef", 10, 200);
    const decidedBy = field(formData, "decidedBy");
    const reason = text(formData, "reason", 10, 500);
    if (!resourceId || !approvalRef || !reason || !["owner_written", "founder_written", "policy_lapse"].includes(decidedBy)) {
      return fail("Give the written reference, the decision type and a reason of 10 to 500 characters. Nothing changed.");
    }
    if (!checked(formData, "irreversibleAck")) return fail("Acknowledge that a provider cancellation cannot be undone. Nothing changed.");
    const data = await loadRecurringFeeOps(createAdminClient(), admin.id);
    const resource = data.overview?.resources.find((r) => r.resourceId === resourceId);
    if (!resource || resource.providerState !== "active") return fail("Only a live resource can be authorized for cancellation. Nothing changed.");
    if (resource.kind === "number" && !data.dual?.some((d) => d.action === "cancel_number" && d.status === "approved" && d.resourceId === resourceId)) {
      return fail("A number cancellation needs an approved dual-control request first. Nothing changed by this submission. If you submitted it a moment ago it may already be authorized: reload and check the operations before filing a new request.");
    }
    if (resource.kind === "number" && decidedBy === "policy_lapse") return fail("A number is never cancelled on a policy lapse. Nothing changed.");
    const out = await lifecycle().authorizeCancel(resourceId, approvalRef, decidedBy as CancelDecision, reason, true, admin.id);
    return done(`Cancellation authorized (operation ${out.operationId}). Nothing has been cancelled: DanceFlow never calls Twilio. Use Begin, perform the console step yourself, then record the evidence.`);
  });
}

export async function rflCancelBeginAction(formData: FormData) {
  await guarded(async (admin) => {
    const operationId = id(formData, "operationId");
    if (!operationId) return fail("Enter the cancellation operation id. Nothing changed.");
    const out = await lifecycle().beginCancel(operationId, admin.id);
    if (out.action === "execute") {
      return done(`Claim recorded (${out.resourceKind.replace("_", " ")}, operation ${operationId.slice(0, 8)}). DanceFlow has NOT cancelled anything: perform the console step yourself now, then record the evidence.`);
    }
    if (out.action === "reconcile") return done("An earlier outcome is unknown: look the resource up in the Twilio console first, then resolve the operation. Nothing was cancelled by DanceFlow.");
    if (out.action === "in_progress") return done("This operation is already claimed. Record the evidence when the console step is done.");
    if (out.action === "unknown_claim") {
      // the database claimed it but its reply was unreadable: record it unknown (never retried; the operator resolves it with a provider lookup)
      try {
        await lifecycle().finishCancel(operationId, "unknown", null, "no_call_malformed_claim", admin.id);
      } catch {
        return fail("The operation is claimed but the database reply could not be read, and recording it as unknown failed. DanceFlow has NOT cancelled anything. Do not perform the console step: reload, then record the outcome as unknown.");
      }
      return fail("The operation is claimed but the database reply could not be read, so it is recorded as an UNKNOWN outcome. DanceFlow has NOT cancelled anything. Look the resource up in the Twilio console, then resolve the operation with the evidence digest.");
    }
    return done(`Nothing to do: this operation is ${out.status}.`);
  });
}

export async function rflCancelFinishAction(formData: FormData) {
  await guarded(async (admin) => {
    const operationId = id(formData, "operationId");
    const outcome = field(formData, "outcome");
    const digest = field(formData, "evidenceDigest");
    const errorCode = field(formData, "errorCode");
    if (!operationId || !["confirmed", "refused", "unknown"].includes(outcome)) return fail("Enter the operation id and choose the outcome. Nothing changed.");
    if (digest && !DIGEST.test(digest)) return fail("The evidence digest must be exactly 64 lowercase hexadecimal characters (a SHA-256). Nothing changed.");
    if (outcome === "refused" && errorCode !== "api") return fail("Record \"Twilio refused\" only for a definite provider refusal, with the error code api; anything else is an unknown outcome. Nothing changed.");
    if (outcome === "confirmed" && !digest) return fail("Confirming a cancellation needs the evidence digest of the console record. Nothing changed.");
    if (errorCode && !ERROR_CODE.test(errorCode)) return fail("The error code is not valid. Nothing changed.");
    const out = await lifecycle().finishCancel(operationId, outcome as "confirmed" | "refused" | "unknown", digest || null, errorCode || null, admin.id);
    return done(`Outcome recorded: ${out.status}.`);
  });
}

export async function rflCancelResolveAction(formData: FormData) {
  await guarded(async (admin) => {
    const operationId = id(formData, "operationId");
    const resolution = field(formData, "resolution");
    const digest = field(formData, "evidenceDigest");
    const note = text(formData, "note", 10, 500);
    if (!operationId || !["cancelled", "still_active"].includes(resolution) || !note) return fail("Enter the operation id, the resolution and a note of 10 to 500 characters. Nothing changed.");
    if (digest && !DIGEST.test(digest)) return fail("The evidence digest must be exactly 64 lowercase hexadecimal characters (a SHA-256). Nothing changed.");
    if (!digest) return fail("Resolving needs the evidence digest of the provider read (cancelled: showing the resource gone; still active: showing it present). Nothing changed.");
    const out = await lifecycle().resolveCancel(operationId, resolution as "cancelled" | "still_active", digest || null, note, admin.id);
    return done(`Operation resolved: ${out.status}.`);
  });
}

/**
 * TW-4F F5: provider release through the cancellation runner, offered ONLY when `cancelReleaseRuntime` builds (TW4_CANCEL_RELEASE=on, a target source
 * installed, and an adapter path: the local fakes, or the real adapters the platform runtime supplies). Otherwise it refuses and the manual path stays.
 * The runner claims the operation itself (tw4_rfl_cancel_begin), calls the provider ONCE, reads the result back and records it; an unknown outcome is
 * never repeated. A number additionally needs the consumed approval of two different administrators, checked before anything is claimed.
 */
export async function rflCancelReleaseAction(formData: FormData) {
  await guarded(async (admin) => {
    const operationId = id(formData, "operationId");
    if (!operationId) return fail("Enter the cancellation operation id. Nothing changed.");
    if (!checked(formData, "releaseAck")) return fail("Acknowledge that DanceFlow will release this resource at Twilio now and that it cannot be undone. Nothing changed.");
    const runtime = cancelReleaseRuntime();
    if (!runtime.ok) return fail(`${runtime.reason} Nothing changed; use Begin and the console step instead.`);
    const out = await runtime.runner.run(operationId, admin.id);
    switch (out.result) {
      case "confirmed":
        return done(`Released at Twilio${runtime.mode === "fake" ? " (local fake provider)" : ""} and confirmed by a provider read. Operation ${out.status}.`);
      case "refused":
        return fail("Twilio refused the release; nothing changed at the provider. The operation is closed as refused: a new written authorization is needed to try again.");
      case "unknown":
        return fail(`The release outcome is UNKNOWN (${out.errorCode}). It will not be repeated. Look the resource up in the Twilio console, then resolve the operation with the evidence digest.`);
      case "record_failed":
        if (out.errorCode?.startsWith("no_call_")) {
          return fail(`Nothing was sent to Twilio, but the operation is claimed and recording that failed (${out.errorCode}). Reload, then resolve it with a provider read. Do not release again.`);
        }
        return fail(`The provider step ran but recording it failed. Record it by hand with Record outcome: outcome ${out.outcome}${out.evidenceDigest ? `, evidence digest ${out.evidenceDigest}` : ""}${out.errorCode ? `, error code ${out.errorCode}` : ""}. Do not release again.`);
      case "precondition_refused":
        return fail(`${out.reason} Nothing was claimed or released.`);
      case "in_progress":
        return done("This operation is already claimed. Nothing was released by this submission.");
      case "reconcile":
        return done("An earlier outcome is unknown: look the resource up in the Twilio console first, then resolve the operation. Nothing was released by this submission.");
      default:
        return done(`Nothing to do: this operation is ${out.status}.`);
    }
  });
}

export async function rflCancelWithdrawAction(formData: FormData) {
  await guarded(async (admin) => {
    const operationId = id(formData, "operationId");
    const note = text(formData, "note", 10, 500);
    if (!operationId || !note) return fail("Enter the operation id and a note of 10 to 500 characters. Nothing changed.");
    await lifecycle().withdrawCancel(operationId, note, admin.id);
    return done("The authorization was withdrawn. Nothing was cancelled.");
  });
}
