import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReconcileDeps } from "@/lib/billing/priceTransitionReconcile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const OPEN_STATUSES = ["scheduled", "needs_review"];

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`${what}: ${error?.message ?? "unknown"}`);
}

/** Real dependencies for reconcilePriceTransition: service-role database reads/writes and Stripe READS only. */
export function createReconcileDeps(db: Db, stripe: Stripe): ReconcileDeps {
  return {
    now: () => new Date(),

    async loadTransition(id) {
      const { data, error } = await db.from("price_transitions").select("*, price_transition_notices!inner(new_unit_amount_cents, currency)").eq("id", id).maybeSingle();
      if (error) fail("transition read failed", error);
      if (!data) return null;
      const notice = data.price_transition_notices as { new_unit_amount_cents: number; currency: string };
      return {
        id: data.id,
        status: data.status,
        protectedSubscriptionId: data.protected_subscription_id,
        stripeSubscriptionId: data.stripe_subscription_id,
        stripeScheduleId: data.stripe_schedule_id,
        targetPriceId: data.target_stripe_price_id,
        boundaryAt: new Date(data.boundary_at),
        activatedAt: data.activated_at ? new Date(data.activated_at) : null,
        priceChangedAt: data.price_changed_at ? new Date(data.price_changed_at) : null,
        noticeAmountCents: notice.new_unit_amount_cents,
        noticeCurrency: notice.currency,
      };
    },

    async loadRegistry(id) {
      const { data, error } = await db.from("protected_subscriptions").select("*").eq("id", id).maybeSingle();
      if (error) fail("registry read failed", error);
      return data
        ? { id: data.id, studioId: data.studio_id, stripeCustomerId: data.stripe_customer_id, stripeSubscriptionId: data.stripe_subscription_id, releasedAt: data.released_at, protectionKind: data.protection_kind }
        : null;
    },

    async loadStudioCustomerId(studioId) {
      const billing = await db.from("studio_billing_customers").select("stripe_customer_id").eq("studio_id", studioId).maybeSingle();
      if (billing.error) fail("studio billing customer read failed", billing.error);
      if (billing.data?.stripe_customer_id) return billing.data.stripe_customer_id as string;
      const studio = await db.from("studios").select("stripe_customer_id").eq("id", studioId).maybeSingle();
      if (studio.error) fail("studio read failed", studio.error);
      return (studio.data?.stripe_customer_id as string | null) ?? null;
    },

    async readSubscription(id) {
      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.retrieve(id);
      } catch (error) {
        if ((error as { code?: string }).code === "resource_missing") return null;
        throw error;
      }
      const item = sub.items.data[0];
      const loose = sub as unknown as { current_period_start?: number; current_period_end?: number };
      const itemLoose = item as unknown as { current_period_start: number; current_period_end: number };
      return {
        id: sub.id,
        customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
        status: sub.status,
        currentPeriodStart: new Date((loose.current_period_start ?? itemLoose.current_period_start) * 1000),
        currentPeriodEnd: new Date((loose.current_period_end ?? itemLoose.current_period_end) * 1000),
        scheduleId: typeof sub.schedule === "string" ? sub.schedule : sub.schedule?.id ?? null,
        items: sub.items.data.map((i) => ({ priceId: i.price.id, quantity: i.quantity ?? 1 })),
      };
    },

    async readSchedule(id) {
      try {
        const schedule = await stripe.subscriptionSchedules.retrieve(id);
        return {
          id: schedule.id,
          status: schedule.status,
          subscriptionId: typeof schedule.subscription === "string" ? schedule.subscription : schedule.subscription?.id ?? null,
          currentPhaseStart: schedule.current_phase ? new Date(schedule.current_phase.start_date * 1000) : null,
        };
      } catch (error) {
        if ((error as { code?: string }).code === "resource_missing") return null;
        throw error;
      }
    },

    async readPrice(id) {
      try {
        const price = await stripe.prices.retrieve(id);
        return { id: price.id, unitAmountCents: price.unit_amount, currency: price.currency };
      } catch (error) {
        if ((error as { code?: string }).code === "resource_missing") return null;
        throw error;
      }
    },

    async recordMilestones(id, patch) {
      const update: Record<string, string> = {};
      if (patch.activatedAt) update.activated_at = patch.activatedAt.toISOString();
      if (patch.priceChangedAt) update.price_changed_at = patch.priceChangedAt.toISOString();
      // Conditional on NULL so a concurrent run cannot overwrite a recorded milestone (they are write-once anyway).
      for (const [column, value] of Object.entries(update)) {
        const { error } = await db.from("price_transitions").update({ [column]: value }).eq("id", id).is(column, null).in("status", OPEN_STATUSES);
        if (error) fail("milestone write failed", error);
      }
    },

    async flagReview(id, reasons, evidence) {
      const { error } = await db
        .from("price_transitions")
        .update({ status: "needs_review", review_reason: reasons.join(","), review_evidence: evidence })
        .eq("id", id)
        .eq("status", "scheduled");
      if (error) fail("review flag failed", error);
    },

    async complete(id, evidence) {
      const { data, error } = await db.rpc("complete_price_transition_reconciliation", { p_transition_id: id, p_evidence: evidence });
      if (error) fail("reconciliation completion failed", error);
      return data === "already_reconciled" ? "already_reconciled" : "reconciled";
    },
  };
}

/** The open (scheduled or needs_review) transition for a Stripe subscription id, if any. */
export async function findOpenTransitionId(db: Db, stripeSubscriptionId: string): Promise<string | null> {
  const { data, error } = await db.from("price_transitions").select("id").eq("stripe_subscription_id", stripeSubscriptionId).in("status", OPEN_STATUSES).limit(1);
  if (error) fail("open transition lookup failed", error);
  return data?.[0]?.id ?? null;
}

/** Open transitions whose boundary has passed: the sweep that covers missing or delayed webhook events. */
export async function listDueTransitionIds(db: Db, now: Date): Promise<string[]> {
  const { data, error } = await db.from("price_transitions").select("id").in("status", OPEN_STATUSES).lte("boundary_at", now.toISOString());
  if (error) fail("due transition lookup failed", error);
  return (data ?? []).map((row: { id: string }) => row.id);
}
