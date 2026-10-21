import { normalizeEmail, queueOutboundDelivery } from "@/lib/notifications/outbound";
import type { ProviderFeeAlert, ProviderFeeAlertSink } from "../providerFeeLifecycle";
import type { AlertRecipient, AlertRecipientKind, DeliveryOutcome, ProviderFeeOpsRpc } from "./rpc";
import { renderRflAlertEmail } from "./templates";

/**
 * Delivers one RFL alert as operational email through the existing idempotent outbound queue (D1).
 *
 *  - Recipients come ONLY from `tw4_rfl_alert_recipients` (verified, capped, audience-honouring, never crossing legal businesses; the database authorizes).
 *    Rows are re-checked here (verified flag, audience, address shape) and anything doubtful is recorded `invalid_recipient`, never sent.
 *  - The recipient reference is `<kind>:<user_id>` (never an address). The queue dedupe key is `rfl:<alert-id>:<recipient-ref>`: replays and concurrent
 *    workers collapse to ONE queued email per recipient (the queue's unique conflict returns `duplicate`).
 *  - Studio for the queue row: the studio the recipient row names (owners). A recipient row without one (an administrator) uses the alert's own studio. When
 *    neither exists (an entity-level alert for an administrator) the recipient is recorded `invalid_recipient` and NOT sent (conservative: the queue row needs a
 *    studio and none is named by the database), so the alert fails visibly if nobody else could be reached.
 *  - Every outcome is recorded with the claim token. `recorded: false` means the claim is stale (another worker owns it): stop at once.
 *  - It throws (the runner marks the alert failed and the database bounds the attempts) when no verified recipient exists, when a queue or record call fails,
 *    or when no recipient could be reached. A failing recipient never blocks the others, and queued ones are not repeated on retry (dedupe).
 *  - It never logs, and its errors never contain an address.
 */
export type RflAlertQueue = (params: Parameters<typeof queueOutboundDelivery>[0]) => Promise<{ queued: boolean; skipped: boolean; reason?: string }>;
export type StudioNameLookup = (studioId: string) => Promise<string | null>;
/** The existing outbound_deliveries row for a dedupe key (service role), or null. */
export type ExistingDelivery = { related_table: string | null; related_id: string | null; template_key: string | null };
export type DeliveryByDedupeKey = (dedupeKey: string) => Promise<ExistingDelivery | null>;

export type ProviderFeeAlertSinkDeps = {
  ops: Pick<ProviderFeeOpsRpc, "alertRecipients" | "recordDelivery">;
  queue?: RflAlertQueue;
  studioName?: StudioNameLookup;
  /**
   * Verifies a `duplicate` queue result. The dedupe namespace is global, so staff could pre-insert a row under a guessed `rfl:<alert>:<ref>` key. A duplicate
   * counts as reached ONLY if the existing row is this alert's RFL row (related_table, related_id and the exact template key for this recipient).
   */
  lookupDelivery: DeliveryByDedupeKey;
};

export class ProviderFeeAlertDeliveryError extends Error {
  constructor(readonly code: "no_recipient" | "queue_failed" | "record_failed" | "claim_lost" | "unreachable") {
    super(`rfl alert delivery: ${code}`);
    this.name = `RflAlert_${code}`;
  }
}

/** Existing delivery by dedupe key through an admin client. Any read error propagates (the caller treats the recipient as not reached). */
export function deliveryByDedupeKeyFromAdmin(admin: { from: (table: string) => unknown }): DeliveryByDedupeKey {
  return async (dedupeKey) => {
    const q = (admin.from("outbound_deliveries") as { select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: ExistingDelivery | null; error: unknown }> } } })
      .select("related_table, related_id, template_key").eq("dedupe_key", dedupeKey).maybeSingle();
    const { data, error } = await q;
    if (error) throw new Error("lookup_failed");
    return data ?? null;
  };
}

export const rflRecipientRef = (kind: AlertRecipientKind, userId: string) => `${kind}:${userId}`;
export const rflDedupeKey = (alertId: string, recipientRef: string) => `rfl:${alertId}:${recipientRef}`;

const MAX_OWNERS = 5;
const MAX_ADMINS = 10;

/** Studio name through an admin client (`studios.name`); unreadable is null (the email then simply omits the name). */
export function studioNameFromAdmin(admin: { from: (table: string) => unknown }): StudioNameLookup {
  return async (studioId) => {
    try {
      const q = (admin.from("studios") as { select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { name?: string | null } | null }> } } })
        .select("name").eq("id", studioId).maybeSingle();
      const { data } = await q;
      return typeof data?.name === "string" ? data.name : null;
    } catch {
      return null;
    }
  };
}

export function createProviderFeeAlertSink(deps: ProviderFeeAlertSinkDeps): ProviderFeeAlertSink {
  const queue = (deps.queue ?? queueOutboundDelivery) as RflAlertQueue;
  const lookupName = deps.studioName ?? (async () => null);

  async function record(alert: ProviderFeeAlert, ref: string, kind: AlertRecipientKind, outcome: DeliveryOutcome) {
    let result: { recorded: boolean };
    try {
      result = await deps.ops.recordDelivery(alert.id, alert.claimToken, ref, kind, outcome);
    } catch {
      throw new ProviderFeeAlertDeliveryError("record_failed");
    }
    if (!result.recorded) throw new ProviderFeeAlertDeliveryError("claim_lost");
  }

  function eligible(alert: ProviderFeeAlert, rows: AlertRecipient[]) {
    const owners = rows.filter((r) => r.recipientKind === "owner" && alert.audience !== "admin").slice(0, MAX_OWNERS);
    const admins = rows.filter((r) => r.recipientKind === "admin" && alert.audience !== "owner").slice(0, MAX_ADMINS);
    return [...owners, ...admins];
  }

  return {
    async deliver(alert) {
      let rows: AlertRecipient[];
      try {
        rows = await deps.ops.alertRecipients(alert.id);
      } catch {
        throw new ProviderFeeAlertDeliveryError("record_failed");
      }
      const recipients = eligible(alert, rows);
      if (recipients.length === 0) {
        await record(alert, `${alert.audience === "admin" ? "admin" : "owner"}:none`, alert.audience === "admin" ? "admin" : "owner", "no_recipient");
        throw new ProviderFeeAlertDeliveryError("no_recipient");
      }
      let reached = 0;
      let failures = 0;
      const names = new Map<string, string | null>();
      for (const r of recipients) {
        const ref = rflRecipientRef(r.recipientKind, r.userId);
        const email = r.emailVerified ? normalizeEmail(r.email) : null;
        const studioId = r.studioId ?? alert.studioId;
        if (!email || !studioId) {
          await record(alert, ref, r.recipientKind, "invalid_recipient");
          continue;
        }
        let studioName: string | null = null;
        if (r.recipientKind === "owner") {
          if (!names.has(studioId)) names.set(studioId, await lookupName(studioId).catch(() => null));
          studioName = names.get(studioId) ?? null;
        }
        const mail = renderRflAlertEmail({ kind: alert.kind, summary: alert.summary, recipientKind: r.recipientKind, studioName });
        let outcome: DeliveryOutcome;
        try {
          const result = await queue({
            studioId, channel: "email", templateKey: mail.templateKey, recipientEmail: email, subject: mail.subject, bodyText: mail.bodyText, bodyHtml: mail.bodyHtml,
            relatedTable: "studio_sms_provider_alerts", relatedId: alert.id, dedupeKey: rflDedupeKey(alert.id, ref),
          });
          if (result.queued) outcome = "queued";
          else if (result.reason === "duplicate") {
            const existing = await deps.lookupDelivery(rflDedupeKey(alert.id, ref));
            if (existing && existing.related_table === "studio_sms_provider_alerts" && existing.related_id === alert.id && existing.template_key === mail.templateKey) outcome = "duplicate";
            else {
              failures += 1;   // squatted (or unreadable) key: NOT reached, nothing recorded; the alert fails, is retried and escalated
              continue;
            }
          }
          else if (result.reason === "missing_email") outcome = "invalid_recipient";
          else {
            failures += 1;
            continue;
          }
        } catch {
          failures += 1;   // not recorded: the next claim retries this recipient (the dedupe key keeps it from doubling)
          continue;
        }
        await record(alert, ref, r.recipientKind, outcome);
        if (outcome === "queued" || outcome === "duplicate") reached += 1;
      }
      if (failures > 0) throw new ProviderFeeAlertDeliveryError("queue_failed");
      if (reached === 0) throw new ProviderFeeAlertDeliveryError("unreachable");
    },
  };
}
