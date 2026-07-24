import { createAdminClient } from "@/lib/supabase/admin";

export type AriaOutcomeExpectation = {
  type: string;
  windowDays: number;
};

export function getAriaOutcomeExpectation(
  ruleKey: string | null | undefined,
): AriaOutcomeExpectation | null {
  if (ruleKey === "aria_low_package_balance") {
    return { type: "package_renewal", windowDays: 7 };
  }
  if (ruleKey === "aria_stale_active_student") {
    return { type: "future_appointment", windowDays: 7 };
  }
  if (ruleKey === "aria_intro_no_purchase") {
    return { type: "intro_conversion", windowDays: 7 };
  }
  if (ruleKey === "aria_membership_past_due") {
    return { type: "membership_good_standing", windowDays: 3 };
  }
  if (ruleKey === "aria_membership_canceling") {
    return { type: "membership_cancellation_resolved", windowDays: 5 };
  }
  if (ruleKey === "unsigned_document" || ruleKey === "aria_unsigned_document") {
    return { type: "document_signed", windowDays: 3 };
  }
  if (ruleKey === "aria_payment_exception") {
    return { type: "payment_completed", windowDays: 3 };
  }
  return null;
}

type PendingOutcomeAction = {
  id: string;
  studio_id: string;
  rule_key: string;
  status: string | null;
  client_id: string | null;
  related_table: string | null;
  related_id: string | null;
  execution_sent_at: string | null;
  outcome_type: string | null;
  outcome_expected_by: string | null;
};

type OutcomeEvidence = {
  verified: boolean;
  relatedTable?: string | null;
  relatedId?: string | null;
  evidence?: Record<string, unknown>;
};

async function verifyOutcome(action: PendingOutcomeAction): Promise<OutcomeEvidence> {
  const supabase = createAdminClient();
  const sentAt = action.execution_sent_at ?? new Date(0).toISOString();

  if (action.outcome_type === "package_renewal" && action.client_id) {
    const { data } = await supabase
      .from("client_packages")
      .select("id, name_snapshot, purchase_date, active, created_at")
      .eq("studio_id", action.studio_id)
      .eq("client_id", action.client_id)
      .eq("active", true)
      .neq("id", action.related_id ?? "00000000-0000-0000-0000-000000000000")
      .gte("created_at", sentAt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return data
      ? {
          verified: true,
          relatedTable: "client_packages",
          relatedId: data.id,
          evidence: {
            package_name: data.name_snapshot,
            purchase_date: data.purchase_date,
            created_at: data.created_at,
          },
        }
      : { verified: false };
  }

  if (action.outcome_type === "future_appointment" && action.client_id) {
    const { data } = await supabase
      .from("appointments")
      .select("id, starts_at, status, appointment_type")
      .eq("studio_id", action.studio_id)
      .eq("client_id", action.client_id)
      .gte("starts_at", new Date().toISOString())
      .not("status", "in", "(cancelled,no_show)")
      .order("starts_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    return data
      ? {
          verified: true,
          relatedTable: "appointments",
          relatedId: data.id,
          evidence: {
            starts_at: data.starts_at,
            status: data.status,
            appointment_type: data.appointment_type,
          },
        }
      : { verified: false };
  }

  if (action.outcome_type === "intro_conversion" && action.client_id) {
    const [{ data: pkg }, { data: membership }] = await Promise.all([
      supabase
        .from("client_packages")
        .select("id, name_snapshot, created_at")
        .eq("studio_id", action.studio_id)
        .eq("client_id", action.client_id)
        .gte("created_at", sentAt)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("client_memberships")
        .select("id, name_snapshot, status, created_at")
        .eq("studio_id", action.studio_id)
        .eq("client_id", action.client_id)
        .gte("created_at", sentAt)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (pkg) {
      return {
        verified: true,
        relatedTable: "client_packages",
        relatedId: pkg.id,
        evidence: { conversion: "package", name: pkg.name_snapshot, created_at: pkg.created_at },
      };
    }
    if (membership) {
      return {
        verified: true,
        relatedTable: "client_memberships",
        relatedId: membership.id,
        evidence: {
          conversion: "membership",
          name: membership.name_snapshot,
          status: membership.status,
          created_at: membership.created_at,
        },
      };
    }
    return { verified: false };
  }

  if (action.outcome_type === "membership_good_standing" && action.related_id) {
    const { data } = await supabase
      .from("client_memberships")
      .select("id, status, current_period_end, cancel_at_period_end")
      .eq("id", action.related_id)
      .eq("studio_id", action.studio_id)
      .maybeSingle();

    const verified = Boolean(data && ["active", "trialing"].includes(data.status ?? ""));
    return verified
      ? {
          verified: true,
          relatedTable: "client_memberships",
          relatedId: data?.id ?? null,
          evidence: {
            status: data?.status,
            current_period_end: data?.current_period_end,
            cancel_at_period_end: data?.cancel_at_period_end,
          },
        }
      : { verified: false };
  }

  if (action.outcome_type === "membership_cancellation_resolved" && action.related_id) {
    const { data } = await supabase
      .from("client_memberships")
      .select("id, status, cancel_at_period_end, auto_renew, ends_on")
      .eq("id", action.related_id)
      .eq("studio_id", action.studio_id)
      .maybeSingle();

    const saved = Boolean(
      data && ["active", "trialing"].includes(data.status ?? "") && data.cancel_at_period_end === false,
    );
    const ended = Boolean(data && ["cancelled", "canceled", "ended"].includes(data.status ?? ""));

    return saved || ended
      ? {
          verified: true,
          relatedTable: "client_memberships",
          relatedId: data?.id ?? null,
          evidence: {
            resolution: saved ? "retained" : "ended",
            status: data?.status,
            cancel_at_period_end: data?.cancel_at_period_end,
            auto_renew: data?.auto_renew,
            ends_on: data?.ends_on,
          },
        }
      : { verified: false };
  }

  if (action.outcome_type === "document_signed" && action.related_id) {
    const { data } = await supabase
      .from("document_assignments")
      .select("id, status, completed_at")
      .eq("id", action.related_id)
      .eq("studio_id", action.studio_id)
      .maybeSingle();

    const verified = Boolean(data && ["completed", "signed"].includes(data.status ?? ""));
    return verified
      ? {
          verified: true,
          relatedTable: "document_assignments",
          relatedId: data?.id ?? null,
          evidence: { status: data?.status, completed_at: data?.completed_at },
        }
      : { verified: false };
  }

  if (action.outcome_type === "payment_completed" && action.related_id) {
    const { data } = await supabase
      .from("payments")
      .select("id, status, paid_at, amount")
      .eq("id", action.related_id)
      .eq("studio_id", action.studio_id)
      .maybeSingle();

    const verified = Boolean(
      data && ["paid", "processed", "complete", "completed"].includes(data.status ?? ""),
    );
    return verified
      ? {
          verified: true,
          relatedTable: "payments",
          relatedId: data?.id ?? null,
          evidence: { status: data?.status, paid_at: data?.paid_at, amount: data?.amount },
        }
      : { verified: false };
  }

  return { verified: false };
}

async function recordOutcomeEvent(params: {
  action: PendingOutcomeAction;
  eventType: "outcome_verified" | "outcome_expired";
  newStatus: string;
  evidence: Record<string, unknown>;
}) {
  const supabase = createAdminClient();
  const { error } = await supabase.from("automation_action_events").insert({
    studio_id: params.action.studio_id,
    automation_action_id: params.action.id,
    event_type: params.eventType,
    previous_status: params.action.status,
    new_status: params.newStatus,
    note:
      params.eventType === "outcome_verified"
        ? "ARIA verified the expected business outcome."
        : "The expected outcome window ended without verified evidence.",
    metadata: params.evidence,
    created_by: null,
  });
  if (error) {
    console.warn("Failed to record ARIA outcome event", { actionId: params.action.id, error });
  }
}

export async function verifyPendingAriaOutcomes(limit = 100) {
  const supabase = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from("automation_actions")
    .select(
      "id, studio_id, rule_key, status, client_id, related_table, related_id, execution_sent_at, outcome_type, outcome_expected_by",
    )
    .eq("outcome_status", "pending")
    .order("outcome_expected_by", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load pending ARIA outcomes: ${error.message}`);

  let verified = 0;
  let expired = 0;
  let pending = 0;
  let failed = 0;

  for (const row of (data ?? []) as PendingOutcomeAction[]) {
    try {
      const evidence = await verifyOutcome(row);
      const checkedAt = new Date().toISOString();

      if (evidence.verified) {
        const { error: updateError } = await supabase
          .from("automation_actions")
          .update({
            status: "completed",
            completed_at: checkedAt,
            outcome_status: "verified",
            outcome_verified_at: checkedAt,
            outcome_last_checked_at: checkedAt,
            outcome_related_table: evidence.relatedTable ?? null,
            outcome_related_id: evidence.relatedId ?? null,
            outcome_evidence: evidence.evidence ?? {},
            review_note: "ARIA verified the expected business outcome.",
            updated_at: checkedAt,
          })
          .eq("id", row.id)
          .eq("studio_id", row.studio_id)
          .eq("outcome_status", "pending");
        if (updateError) throw new Error(updateError.message);
        await recordOutcomeEvent({
          action: row,
          eventType: "outcome_verified",
          newStatus: "completed",
          evidence: evidence.evidence ?? {},
        });
        verified += 1;
        continue;
      }

      const expectedBy = row.outcome_expected_by ? new Date(row.outcome_expected_by) : null;
      if (expectedBy && !Number.isNaN(expectedBy.getTime()) && expectedBy <= now) {
        const { error: updateError } = await supabase
          .from("automation_actions")
          .update({
            status: "failed",
            outcome_status: "expired",
            outcome_last_checked_at: checkedAt,
            outcome_evidence: {
              reason: "expected_outcome_not_verified_before_deadline",
              expected_by: row.outcome_expected_by,
            },
            review_note: "The expected outcome was not verified before the follow-up window ended.",
            updated_at: checkedAt,
          })
          .eq("id", row.id)
          .eq("studio_id", row.studio_id)
          .eq("outcome_status", "pending");
        if (updateError) throw new Error(updateError.message);
        await recordOutcomeEvent({
          action: row,
          eventType: "outcome_expired",
          newStatus: "failed",
          evidence: { expected_by: row.outcome_expected_by, checked_at: checkedAt },
        });
        expired += 1;
        continue;
      }

      await supabase
        .from("automation_actions")
        .update({ outcome_last_checked_at: checkedAt, updated_at: checkedAt })
        .eq("id", row.id)
        .eq("studio_id", row.studio_id)
        .eq("outcome_status", "pending");
      pending += 1;
    } catch (error) {
      failed += 1;
      console.error("ARIA outcome verification failed", { actionId: row.id, error });
    }
  }

  return { processed: (data ?? []).length, verified, expired, pending, failed, evaluatedAt: nowIso };
}
