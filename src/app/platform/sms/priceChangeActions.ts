"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePlatformStepUp, type AssuranceTier } from "@/lib/auth/platform-assurance";
import { PRICE_FLASH_COOKIE, PRICE_KINDS, PriceChangeError, PriceChangeStore, isB64u, type AuthzChallenge, type CredChallenge, type CredentialState } from "@/lib/sms/priceChange";
import { encodePanelFlash } from "@/lib/sms/twilioIsv/panelFlash";
import { usdToCents } from "@/lib/sms/pilotApprovalEvidence";

/**
 * D4-1: SMS price changes need TWO different platform administrators. Every action runs `requirePlatformStepUp()` FIRST (which runs `requirePlatformAdmin()` and then
 * demands the verified AAL2 session, plus a fresh authenticator code for a proposal or an approval), validates its inputs, and only then calls the database WITH THE
 * ADMINISTRATOR'S OWN SESSION (the user-scoped client: no service-role key, no actor argument, the identity is auth.uid()). The database checks that session again (aal2, a recent TOTP), the protected approver registry, refuses a requester approving their own proposal, and re-checks both
 * administrators, the expiry and the active price under locks. Database error text is never shown: SQLSTATEs map to fixed sentences. Nothing here calls Twilio or Stripe,
 * and a proposal changes no price; only the second administrator's approval publishes one.
 */

const RETURN_PATH = "/platform/sms";
const ANCHOR = "#price-changes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Flash = { ok: boolean; message: string };
const fail = (message: string): Flash => ({ ok: false, message });
const done = (message: string): Flash => ({ ok: true, message });

const ERRORS: Record<string, string> = {
  "42501": "Not allowed. Price changes need a registered administrator in a second-factor session; publication also needs a different session and the hardware key, and is refused while prices are suspended. Only an active platform administrator can do this, and a price change can never be approved by the administrator who proposed it. Nothing changed.",
  "22023": "The database refused the input (check the kind, the amounts, the lengths, and that the proposal differs from the active price). Nothing changed.",
  TW045: "The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.",
  TW041: "This is not allowed in the proposal's current state (another proposal for this price is still open, or this one is already decided). Nothing changed.",
  TW042: "Prices can only be changed by a proposal and a second administrator's approval. Nothing changed.",
  "23514": "The database refused the amounts. Nothing changed.",
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

/** Back to the panel with the result. The text goes in a short-lived httpOnly cookie, never the URL (a crafted link cannot show a fake result). */
async function finish(result: Flash): Promise<never> {
  revalidatePath(RETURN_PATH);
  (await cookies()).set(PRICE_FLASH_COOKIE, encodePanelFlash(result), {
    httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: RETURN_PATH, maxAge: 60,
  });
  // redirect throws: it stays outside any try/catch
  redirect(`${RETURN_PATH}?${result.ok ? "price" : "price_error"}=1${ANCHOR}`);
}

async function guarded(tier: AssuranceTier, work: (admin: { id: string }) => Promise<Flash>): Promise<never> {
  const admin = await requirePlatformStepUp(tier);
  let result: Flash;
  try {
    result = await work(admin);
  } catch (e) {
    result = fail(describeError(e));
  }
  return finish(result);
}

const store = async () => new PriceChangeStore(await createClient());

export async function pricePropose(formData: FormData) {
  await guarded("recent", async () => {
    const kind = field(formData, "kind");
    const customer = usdToCents(field(formData, "customerUsd"));
    const provider = usdToCents(field(formData, "providerUsd"));
    const description = text(formData, "description", 3, 200);
    const reason = text(formData, "reason", 10, 500);
    if (!PRICE_KINDS.includes(kind) || customer === null || customer <= 0 || provider === null || !description || !reason) {
      return fail("Choose a price kind, give the customer price (above zero) and DanceFlow's provider cost in dollars, a description (3 to 200 characters) and a written reason (10 to 500). Nothing changed.");
    }
    const out = await (await store()).propose({ kind, customerCents: customer, providerCents: provider, description, reason });
    return done(out.replayed
      ? "This identical proposal is already waiting for a second administrator. Nothing changed."
      : "Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.");
  });
}

export async function priceApprove(formData: FormData) {
  await guarded("recent", async () => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give an approval note of 10 to 500 characters. Nothing changed.");
    const out = await (await store()).approve(requestId, note);
    if (out.status === "applied") return done(out.replayed ? "This proposal was already approved by you and is in effect." : "Approved. The new price is now the published price. Existing money movements are not changed.");
    if (out.status === "expired") return fail("The proposal had expired. No price changed.");
    if (out.status === "invalidated") return fail("The active price (or the proposer's standing) changed since the proposal, so it was invalidated. No price changed; make a new proposal.");
    return fail("The proposal was not approved. Reload and check its state.");
  });
}

export async function priceReject(formData: FormData) {
  await guarded("aal2", async () => {
    const requestId = id(formData, "requestId");
    const note = text(formData, "note", 10, 500);
    if (!requestId || !note) return fail("Give a note of 10 to 500 characters. Nothing changed.");
    const out = await (await store()).reject(requestId, note);
    return done(out.withdrawn ? "Your proposal was withdrawn. No price changed." : "The proposal was rejected. No price changed.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// single-owner mode: revise, the two-step hardware-key authorization, suspension
// ---------------------------------------------------------------------------------------------------------------
type Data<T> = { ok: true; data: T } | { ok: false; message: string };

/** Like `guarded` but returns data to the calling component (the WebAuthn ceremony needs the challenge back in the browser). The step-up guard still runs FIRST. */
async function guardedData<T>(tier: AssuranceTier, work: () => Promise<T>): Promise<Data<T>> {
  await requirePlatformStepUp(tier);
  try {
    return { ok: true, data: await work() };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

/** Step 1: the DATABASE issues the challenge for one proposal to this session. The owner reads the summary it returns, which comes from the database row. */
export async function priceAuthzBegin(requestId: string): Promise<Data<AuthzChallenge>> {
  return await guardedData("aal2", async () => {
    if (typeof requestId !== "string" || !UUID.test(requestId)) throw new PriceChangeError("22023");
    return (await store()).authzBegin(requestId);
  });
}

/** Step 2: the signed assertion goes to the database, which verifies it (inside Postgres) and publishes. A rejected assertion is reported with its reason; nothing is published. */
type AuthzFinishInput = Record<"requestId" | "nonce" | "credentialId" | "authData" | "clientData" | "signature", string>;
type AuthzFinishOut = Data<Record<"status" | "reason", string | null>>;
export async function priceAuthzFinish(input: AuthzFinishInput): Promise<AuthzFinishOut> {
  return await guardedData("aal2", async () => {
    const i = input as Record<string, unknown>;
    if (typeof i?.requestId !== "string" || !UUID.test(i.requestId) || !isB64u(i.nonce) || !isB64u(i.credentialId) || !isB64u(i.authData) || !isB64u(i.clientData) || !isB64u(i.signature)) {
      throw new PriceChangeError("22023");
    }
    return (await store()).authzFinish({ requestId: i.requestId, nonce: i.nonce, credentialId: i.credentialId, authData: i.authData, clientData: i.clientData, signature: i.signature });
  });
}

export async function priceRevise(formData: FormData) {
  await guarded("recent", async () => {
    const requestId = id(formData, "requestId");
    const customer = usdToCents(field(formData, "customerUsd"));
    const provider = usdToCents(field(formData, "providerUsd"));
    const description = text(formData, "description", 3, 200);
    const reason = text(formData, "reason", 10, 500);
    if (!requestId || customer === null || customer <= 0 || provider === null || !description || !reason) return fail("Give the new customer price, provider cost, a description and a written reason. Nothing changed.");
    const out = await (await store()).revise(requestId, { customerCents: customer, providerCents: provider, description, reason });
    return done(`Revised (version ${out.version}). The earlier proposal and any signature over it are void and the 24-hour cooling-off starts again.`);
  });
}

/** Suspends price publication. It can only suspend; lifting it needs the hardware key. */
export async function priceFreeze(formData: FormData) {
  await guarded("aal2", async () => {
    const reason = text(formData, "reason", 10, 300);
    if (!reason) return fail("Give a written reason of 10 to 300 characters. Nothing changed.");
    await (await store()).freeze(reason);
    return done("Price publication is suspended. It publishes nothing; lifting the suspension needs the hardware key.");
  });
}

export async function priceReportCompromise(formData: FormData) {
  await guarded("aal2", async () => {
    const note = text(formData, "note", 10, 300);
    if (!note) return fail("Describe what you suspect in 10 to 300 characters. Nothing changed.");
    await (await store()).reportCompromise(note);
    return done("Reported. Price publication is suspended and the security event is raised.");
  });
}

// ---------------------------------------------------------------------------------------------------------------
// credential ceremonies: enrol / revoke are PENDING requests (a mandatory delay applies), apply and cancel act on a pending change, thaw lifts a suspension with the hardware key
// ---------------------------------------------------------------------------------------------------------------
const bad = (...v: unknown[]) => {
  if (v.some((x) => !isB64u(x))) throw new PriceChangeError("22023");
};

export async function priceCredBegin(input: { purpose: string; credentialId?: string; x?: string; y?: string; role?: string; label?: string; changeId?: string }): Promise<Data<CredChallenge>> {
  return await guardedData("aal2", async () => {
    const purpose = input?.purpose;
    if (purpose !== "enroll" && purpose !== "revoke" && purpose !== "thaw" && purpose !== "cancel") throw new PriceChangeError("22023");
    if (purpose === "cancel" && (typeof input.changeId !== "string" || !UUID.test(input.changeId))) throw new PriceChangeError("22023");
    if (purpose === "enroll") bad(input.credentialId, input.x, input.y);
    if (purpose === "revoke") bad(input.credentialId);
    if (purpose === "enroll" && (typeof input.role !== "string" || !["primary", "spare"].includes(input.role) || typeof input.label !== "string" || input.label.trim().length < 3 || input.label.length > 60)) throw new PriceChangeError("22023");
    return (await store()).credBegin({ purpose, credentialId: input.credentialId ?? null, x: input.x ?? null, y: input.y ?? null, role: input.role ?? null, label: input.label ?? null, changeId: input.changeId ?? null });
  });
}

type CredEnrollInput = Record<"nonce" | "newCredentialId" | "x" | "y" | "role" | "label" | "byCredentialId" | "byAuth" | "byClient" | "bySig" | "newAuth" | "newClient" | "newSig", string>;
export async function priceCredEnroll(input: CredEnrollInput): Promise<Data<Record<"status" | "reason" | "changeId", string | null>>> {
  return await guardedData("aal2", async () => {
    const i = input as Record<string, unknown>;
    bad(i?.nonce, i?.newCredentialId, i?.x, i?.y, i?.byCredentialId, i?.byAuth, i?.byClient, i?.bySig, i?.newAuth, i?.newClient, i?.newSig);
    if (i.role !== "primary" && i.role !== "spare") throw new PriceChangeError("22023");
    if (typeof i.label !== "string" || i.label.trim().length < 3 || i.label.length > 60) throw new PriceChangeError("22023");
    return (await store()).credEnroll(input);
  });
}

type CredRevokeInput = Record<"nonce" | "target" | "byCredentialId" | "byAuth" | "byClient" | "bySig", string>;
export async function priceCredRevoke(input: CredRevokeInput): Promise<Data<Record<"status" | "reason" | "changeId", string | null>>> {
  return await guardedData("aal2", async () => {
    const i = input as Record<string, unknown>;
    bad(i?.nonce, i?.target, i?.byCredentialId, i?.byAuth, i?.byClient, i?.bySig);
    return (await store()).credRevoke(input);
  });
}

type ThawInput = Record<"nonce" | "credentialId" | "authData" | "clientData" | "signature", string>;
export async function priceThaw(input: ThawInput): Promise<Data<Record<"status" | "reason", string | null>>> {
  return await guardedData("aal2", async () => {
    const i = input as Record<string, unknown>;
    bad(i?.nonce, i?.credentialId, i?.authData, i?.clientData, i?.signature);
    return (await store()).thaw(input);
  });
}

export async function priceCredApply(changeId: string): Promise<Data<Record<"status", string | null>>> {
  return await guardedData("aal2", async () => {
    if (typeof changeId !== "string" || !UUID.test(changeId)) throw new PriceChangeError("22023");
    return (await store()).credApply(changeId);
  });
}

type CancelInput = Record<"changeId" | "nonce" | "credentialId" | "authData" | "clientData" | "signature", string>;
export async function priceCredCancel(input: CancelInput): Promise<Data<Record<"status" | "reason", string | null>>> {
  return await guardedData("aal2", async () => {
    const i = input as Record<string, unknown>;
    if (typeof i?.changeId !== "string" || !UUID.test(i.changeId)) throw new PriceChangeError("22023");
    bad(i.nonce, i.credentialId, i.authData, i.clientData, i.signature);
    return (await store()).credCancel(input);
  });
}

export async function priceCredPending(): Promise<Data<CredentialState>> {
  return await guardedData("aal2", async () => (await store()).credState());
}
