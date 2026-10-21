import type { LedgerError, LedgerResolution, LedgerSnapshot } from "./provisionLedger";

/**
 * TW-4F R2c-I1: validation and pre-checks for the two platform-admin ledger commands. Pure over an injected store so every refusal is testable; the
 * server action (`provisioningActions.ts`) runs `requirePlatformAdmin` first and passes the SESSION-derived admin id. Nothing here is a second source of
 * truth: the database re-checks the admin, the time windows, the SID shape and the reservation rules on every call. These pre-checks exist so that
 *   - a browser-supplied operation id is only ever acted on if it belongs to the ledger of the studio the admin is looking at (no cross-studio id),
 *   - a replayed or stale submission is refused with a clear message instead of reaching the database,
 *   - a financially significant resolution always carries an explicit confirmation and a written reason, and
 *   - anything that cannot be verified fails closed.
 * No command contacts a provider.
 */

export type CommandResult = { ok: boolean; message: string };

export type LedgerPort = {
  status(studioId: string, actorId: string): Promise<LedgerSnapshot | null>;
  resolve(args: { operationId: string; actorId: string; resolution: LedgerResolution; providerSid: string | null; note: string }): Promise<void>;
  reopen(studioId: string, actorId: string, reason: string): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = { messaging_service: /^MG[0-9a-fA-F]{32}$/, campaign: /^QE[0-9a-fA-F]{32}$/ } as const;
/** The database requires 20 minutes before an in-flight attempt, or a fee operation declared "not created", can be closed (R2a). Mirrored for early, clear refusal only. */
export const RESOLVE_WAIT_MS = 20 * 60 * 1000;
export const CONFIRM_PHRASE = "RESOLVE";

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const bad = (message: string): CommandResult => ({ ok: false, message });
const good = (message: string): CommandResult => ({ ok: true, message });
const printable = (v: string, min: number, max: number) => v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** Plain-language mapping of a database refusal. Never forwards database text. */
export function ledgerErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error && "code" in error ? String((error as LedgerError).code) : "unknown";
  switch (code) {
    case "42501": return "You are not allowed to do this.";
    case "55P03": return "A run is working on this studio right now. Try again when it finishes.";
    case "22023": return "The database refused the resolution (check the reason, the resource SID and the 20-minute waiting rules). Nothing was changed.";
    case "TW030": return "There is no provisioning exception to reopen. Nothing was changed.";
    case "TW034": return "Resolve the unknown outcome first. Nothing was changed.";
    default: return "The change could not be made. Nothing was changed.";
  }
}

const isUnresolved = (status: string) => status === "unknown_outcome" || status === "in_flight";

export async function resolveOperation(store: LedgerPort, actorId: string, form: FormData, now: number = Date.now()): Promise<CommandResult> {
  const studioId = field(form, "studioId");
  const operationId = field(form, "operationId");
  const resolution = field(form, "resolution");
  const note = field(form, "note");
  const providerSid = field(form, "providerSid");
  if (!UUID.test(studioId) || !UUID.test(operationId)) return bad("Choose an operation from the list.");
  if (resolution !== "created" && resolution !== "not_created") return bad("Choose what you found at the provider.");
  if (!printable(note, 10, 500)) return bad("Write what you checked at the provider (10-500 characters). Never type an EIN or a secret.");

  // fail closed: the operation must be in THIS studio's ledger, as the database reports it right now
  let ledger: LedgerSnapshot | null;
  try {
    ledger = await store.status(studioId, actorId);
  } catch {
    return bad("The provisioning ledger could not be read, so nothing was changed.");
  }
  const op = ledger?.operations.find((o) => o.id === operationId);
  if (!ledger || !op) return bad("That operation is not part of this studio's ledger. Nothing was changed.");
  if (!isUnresolved(op.status) || op.superseded) return bad("This operation was already resolved or is no longer open. Reload to see its current state. Nothing was changed.");
  if (ledger.leased) return bad("A run is working on this studio right now. Try again when it finishes.");

  const started = op.attemptedAt ? Date.parse(op.attemptedAt) : NaN;
  const age = Number.isFinite(started) ? now - started : NaN;
  if (!Number.isFinite(age)) return bad("The attempt time is unknown, so the waiting rule cannot be verified. Nothing was changed.");
  if (op.status === "in_flight" && age < RESOLVE_WAIT_MS) return bad("This attempt is still in flight. It can be resolved 20 minutes after it started.");
  if (op.feeBearing && resolution === "not_created" && age < RESOLVE_WAIT_MS) return bad("A fee operation cannot be declared not created within 20 minutes of its attempt.");

  if (resolution === "created") {
    const pattern = op.kind === "messaging_service" ? SID.messaging_service : op.kind === "campaign" ? SID.campaign : null;
    if (!pattern || !pattern.test(providerSid)) return bad("Enter the resource SID you found at the provider, exactly as shown there.");
  }

  // explicit confirmation: always, and for a fee-bearing operation also a typed phrase (releasing or holding money depends on this choice)
  if (form.get("confirm") !== "on") return bad("Confirm that you checked the provider yourself.");
  if (op.feeBearing && field(form, "phrase") !== CONFIRM_PHRASE) return bad(`This operation involves a fee. Type ${CONFIRM_PHRASE} to confirm.`);

  try {
    await store.resolve({ operationId, actorId, resolution, providerSid: resolution === "created" ? providerSid : null, note });
  } catch (error) {
    return bad(ledgerErrorMessage(error));
  }
  if (resolution === "created") return good("Recorded as created at the provider. Nothing is charged by this: a fee is captured only after a provider read confirms the resource.");
  return good(op.feeBearing ? "Recorded as not created. The fee set aside for this attempt was released." : "Recorded as not created.");
}

export async function reopenProvisioning(store: LedgerPort, actorId: string, form: FormData): Promise<CommandResult> {
  const studioId = field(form, "studioId");
  const reason = field(form, "reason");
  if (!UUID.test(studioId)) return bad("Choose a studio.");
  if (!printable(reason, 10, 300)) return bad("Write why this can continue (10-300 characters).");
  if (form.get("confirm") !== "on") return bad("Confirm that the exception was understood.");
  let ledger: LedgerSnapshot | null;
  try {
    ledger = await store.status(studioId, actorId);
  } catch {
    return bad("The provisioning ledger could not be read, so nothing was changed.");
  }
  if (!ledger || ledger.state !== "exception") return bad("There is no provisioning exception to reopen. Nothing was changed.");
  if (ledger.operations.some((o) => isUnresolved(o.status) && !o.superseded)) return bad("Resolve the unknown outcome first. Nothing was changed.");
  try {
    await store.reopen(studioId, actorId, reason);
  } catch (error) {
    return bad(ledgerErrorMessage(error));
  }
  return good("Reopened. Nothing was submitted, charged or created by this.");
}
