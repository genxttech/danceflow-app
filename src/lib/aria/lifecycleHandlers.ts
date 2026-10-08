import type { SupabaseClient } from "@supabase/supabase-js";
import { getEventStartUtc } from "@/lib/events/eventTiming";
import type { AriaActionResolution, ReconcilableAriaAction } from "./actionReconciliation";

/*
  Cleanup PR C2: current-state lifecycle handlers for the remaining ARIA opportunity types.

  Each handler loads the exact source records behind open actions of one rule (studio-scoped, batched) and returns:
  - complete: the condition that created the action is now definitively false in DanceFlow;
  - expire:   the opportunity's actionable window has ended (stored as the existing `skipped` status);
  - refresh:  the action stays open for human judgement, but its stored wording states a fact that is no longer true,
              so the wording is superseded with current facts.
  Missing, unreadable or unrecognised source state is ambiguous and leaves the action untouched.

  Wording for conditions that are still true is refreshed by generation (insertAriaOperationalActions); these handlers
  cover the cases where the condition is no longer true, so generation would never touch the action again.
*/

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export type AriaLifecycleHandlerContext = {
  supabase: AnySupabaseClient;
  studioId: string;
  now: Date;
  actions: ReconcilableAriaAction[];
};

export type AriaLifecycleHandler = {
  relatedTable: string;
  resolve: (context: AriaLifecycleHandlerContext) => Promise<AriaActionResolution[]>;
};

type Row = Record<string, unknown>;

function ids(actions: ReconcilableAriaAction[]) {
  return Array.from(new Set(actions.map((action) => action.related_id).filter((id): id is string => Boolean(id))));
}

function norm(value: unknown) {
  return `${value ?? ""}`.trim().toLowerCase().replaceAll(" ", "_");
}

function num(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function loadById(
  supabase: AnySupabaseClient,
  table: string,
  columns: string,
  studioId: string,
  idList: string[],
): Promise<Map<string, Row>> {
  if (idList.length === 0) return new Map();
  const { data, error } = await supabase.from(table).select(columns).eq("studio_id", studioId).in("id", idList);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as unknown as Row[]).map((row) => [String(row.id), row]));
}

function complete(
  action: ReconcilableAriaAction,
  reason: string,
  note: string,
  evidence: Record<string, unknown> = {},
): AriaActionResolution {
  return { actionId: action.id, kind: "complete", reason, note, evidence };
}

function expire(
  action: ReconcilableAriaAction,
  reason: string,
  note: string,
  evidence: Record<string, unknown> = {},
): AriaActionResolution {
  return { actionId: action.id, kind: "expire", reason, note, evidence };
}

/** Appointment statuses (appointment_status enum) that count as a booked lesson. */
const BOOKED_APPOINTMENT_STATUSES = ["scheduled", "confirmed", "attended"];
const APPOINTMENT_STATUSES = ["scheduled", "attended", "cancelled", "no_show", "rescheduled", "confirmed"];
const CLIENT_STATUSES = ["lead", "active", "inactive", "archived", "contacted", "consultation_booked", "converted", "lost"];

/** Future booked appointments per client (studio-scoped). */
async function clientsWithFutureBooking(supabase: AnySupabaseClient, studioId: string, clientIds: string[], now: Date) {
  if (clientIds.length === 0) return new Set<string>();
  const { data, error } = await supabase
    .from("appointments")
    .select("client_id, status, starts_at")
    .eq("studio_id", studioId)
    .in("client_id", clientIds)
    .gte("starts_at", now.toISOString());
  if (error) throw new Error(error.message);
  return new Set(
    ((data ?? []) as Row[])
      .filter((row) => BOOKED_APPOINTMENT_STATUSES.includes(norm(row.status)))
      .map((row) => String(row.client_id)),
  );
}

/* ---------------------------------------------- A: objective ---------------------------------------------------- */

/** aria_document_expiration (overdue required document) and legacy unsigned_document. */
function documentHandler(options: { dueDateMatters: boolean }): AriaLifecycleHandler {
  return {
    relatedTable: "document_assignments",
    async resolve({ supabase, studioId, now, actions }) {
      const rows = await loadById(supabase, "document_assignments", "id, status, due_at", studioId, ids(actions));
      return actions.flatMap((action) => {
        const row = action.related_id ? rows.get(action.related_id) : undefined;
        if (!row) return [];
        const status = norm(row.status);
        if (["signed", "waived", "void"].includes(status)) {
          return [complete(action, "document_no_longer_pending", `Completed automatically: this document is now ${status}.`, { document_status: status })];
        }
        if (status !== "pending") return [];
        if (options.dueDateMatters && row.due_at && new Date(String(row.due_at)).getTime() > now.getTime()) {
          return [
            complete(action, "document_due_date_extended", "Completed automatically: this document's due date has been moved into the future.", {
              due_at: row.due_at,
            }),
          ];
        }
        return [];
      });
    },
  };
}

const orderFulfillmentHandler: AriaLifecycleHandler = {
  relatedTable: "commerce_orders",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "commerce_orders", "id, status, fulfillment_status", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const fulfillment = norm(row.fulfillment_status);
      const status = norm(row.status);
      if (["fulfilled", "not_required", "cancelled"].includes(fulfillment)) {
        return [
          complete(action, "order_fulfilled", `Completed automatically: this order's fulfillment is now ${fulfillment.replaceAll("_", " ")}.`, {
            fulfillment_status: fulfillment,
          }),
        ];
      }
      if (status === "cancelled") {
        return [complete(action, "order_cancelled", "Completed automatically: this order was cancelled.", { order_status: status })];
      }
      return [];
    });
  },
};

const eventUnpaidRegistrationHandler: AriaLifecycleHandler = {
  relatedTable: "event_registrations",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "event_registrations", "id, status, payment_status", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const payment = norm(row.payment_status);
      const status = norm(row.status);
      if (["paid", "refunded"].includes(payment)) {
        return [complete(action, "registration_payment_settled", `Completed automatically: this registration is now ${payment}.`, { payment_status: payment })];
      }
      if (["cancelled", "refunded"].includes(status)) {
        return [complete(action, "registration_closed", `Completed automatically: this registration was ${status}.`, { registration_status: status })];
      }
      return [];
    });
  },
};

const instructorCoverageHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, now, actions }) {
    const rows = await loadById(supabase, "appointments", "id, status, instructor_id, starts_at", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const status = norm(row.status);
      if (row.instructor_id) {
        return [complete(action, "instructor_assigned", "Completed automatically: an instructor is now assigned to this appointment.")];
      }
      if (status === "cancelled") {
        return [complete(action, "appointment_cancelled", "Completed automatically: this appointment was cancelled.")];
      }
      const startsAt = new Date(String(row.starts_at ?? "")).getTime();
      if (Number.isFinite(startsAt) && startsAt <= now.getTime()) {
        return [expire(action, "coverage_window_passed", "Closed automatically: this appointment's start time has passed, so the coverage request is no longer current.")];
      }
      return [];
    });
  },
};

/** aria_lead_follow_up_sequence and aria_staff_task_reminder (same overdue lead activity). */
const leadActivityHandler: AriaLifecycleHandler = {
  relatedTable: "lead_activities",
  async resolve({ supabase, studioId, now, actions }) {
    const rows = await loadById(supabase, "lead_activities", "id, completed_at, follow_up_due_at", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      if (row.completed_at) {
        return [complete(action, "lead_activity_completed", "Completed automatically: this follow-up has been marked complete.")];
      }
      if (!row.follow_up_due_at) {
        return [complete(action, "lead_activity_no_due_date", "Completed automatically: this activity no longer has a follow-up due date.")];
      }
      if (new Date(String(row.follow_up_due_at)).getTime() > now.getTime()) {
        return [complete(action, "lead_activity_rescheduled", "Completed automatically: this follow-up has been rescheduled to a future date.")];
      }
      return [];
    });
  },
};

const leadAcknowledgementHandler: AriaLifecycleHandler = {
  relatedTable: "clients",
  async resolve({ supabase, studioId, actions }) {
    const clientIds = ids(actions);
    const clients = await loadById(supabase, "clients", "id, status", studioId, clientIds);
    const { data, error } = clientIds.length
      ? await supabase.from("lead_activities").select("client_id").eq("studio_id", studioId).in("client_id", clientIds)
      : { data: [], error: null };
    if (error) throw new Error(error.message);
    const withActivity = new Set(((data ?? []) as Row[]).map((row) => String(row.client_id)));
    return actions.flatMap((action) => {
      const clientId = action.related_id;
      const client = clientId ? clients.get(clientId) : undefined;
      if (!clientId || !client) return [];
      if (withActivity.has(clientId)) {
        return [complete(action, "lead_activity_recorded", "Completed automatically: lead activity has now been recorded for this client.")];
      }
      const status = norm(client.status);
      if (CLIENT_STATUSES.includes(status) && status !== "lead") {
        return [complete(action, "no_longer_lead", `Completed automatically: this client is now ${status.replaceAll("_", " ")}.`, { client_status: status })];
      }
      return [];
    });
  },
};

const inventoryHandler: AriaLifecycleHandler = {
  relatedTable: "commerce_product_variant_inventory",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(
      supabase,
      "commerce_product_variant_inventory",
      "id, quantity_on_hand, reorder_threshold, active",
      studioId,
      ids(actions),
    );
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      if (row.active === false) {
        return [complete(action, "inventory_inactive", "Completed automatically: this product variant is no longer active.")];
      }
      const onHand = num(row.quantity_on_hand, 0);
      const threshold = num(row.reorder_threshold, 0);
      if (onHand > threshold) {
        return [
          complete(action, "inventory_restocked", `Completed automatically: stock is now ${onHand}, above the reorder threshold of ${threshold}.`, {
            quantity_on_hand: onHand,
            reorder_threshold: threshold,
          }),
        ];
      }
      return [];
    });
  },
};

const payrollSetupHandler: AriaLifecycleHandler = {
  relatedTable: "instructors",
  async resolve({ supabase, studioId, actions }) {
    const instructorIds = ids(actions);
    const instructors = await loadById(supabase, "instructors", "id, active", studioId, instructorIds);
    if (instructorIds.length === 0) return [];
    const [{ data: profiles, error: profileError }, { data: rules, error: rulesError }] = await Promise.all([
      supabase
        .from("instructor_payroll_profiles")
        .select("instructor_id, worker_classification, payroll_active")
        .eq("studio_id", studioId)
        .in("instructor_id", instructorIds),
      supabase.from("instructor_compensation_rules").select("instructor_id").eq("studio_id", studioId).in("instructor_id", instructorIds),
    ]);
    if (profileError) throw new Error(profileError.message);
    if (rulesError) throw new Error(rulesError.message);
    const profileByInstructor = new Map(((profiles ?? []) as Row[]).map((row) => [String(row.instructor_id), row]));
    const withRule = new Set(((rules ?? []) as Row[]).map((row) => String(row.instructor_id)));
    return actions.flatMap((action) => {
      const instructorId = action.related_id;
      const instructor = instructorId ? instructors.get(instructorId) : undefined;
      if (!instructorId || !instructor) return [];
      if (instructor.active === false) {
        return [complete(action, "instructor_inactive", "Completed automatically: this instructor is no longer active.")];
      }
      const profile = profileByInstructor.get(instructorId);
      if (profile && profile.payroll_active === false) {
        return [complete(action, "payroll_inactive", "Completed automatically: this instructor is no longer active for payroll.")];
      }
      if (profile && profile.worker_classification && withRule.has(instructorId)) {
        return [complete(action, "payroll_setup_complete", "Completed automatically: worker classification and a compensation rule are now on file.")];
      }
      return [];
    });
  },
};

/** Organizer event rules: confirm the event belongs to the studio before reading its financial view row. */
async function studioEvents(supabase: AnySupabaseClient, studioId: string, eventIds: string[]) {
  return loadById(supabase, "events", "id, name, status, start_date, start_time, end_date, end_time, timezone, capacity", studioId, eventIds);
}

async function profitRows(supabase: AnySupabaseClient, eventIds: string[]) {
  if (eventIds.length === 0) return new Map<string, Row>();
  const { data, error } = await supabase
    .from("v_event_profit_loss")
    .select("event_id, net_ticket_revenue, event_profit_loss, event_expenses, event_labor_costs")
    .in("event_id", eventIds);
  if (error) throw new Error(error.message);
  return new Map(((data ?? []) as Row[]).map((row) => [String(row.event_id), row]));
}

const eventMissingCostsHandler: AriaLifecycleHandler = {
  relatedTable: "events",
  async resolve({ supabase, studioId, actions }) {
    const events = await studioEvents(supabase, studioId, ids(actions));
    const profit = await profitRows(supabase, Array.from(events.keys()));
    return actions.flatMap((action) => {
      const row = action.related_id ? profit.get(action.related_id) : undefined;
      if (!row) return [];
      const revenue = num(row.net_ticket_revenue, 0);
      const missing = revenue > 0 && (num(row.event_expenses, 0) <= 0 || num(row.event_labor_costs, 0) <= 0);
      if (missing) return [];
      return [complete(action, "event_costs_recorded", "Completed automatically: labor and expense costs are now recorded for this event.")];
    });
  },
};

const studentAppAdoptionHandler: AriaLifecycleHandler = {
  relatedTable: "clients",
  async resolve({ supabase, studioId, actions }) {
    const clientIds = ids(actions);
    const clients = await loadById(supabase, "clients", "id, status, email", studioId, clientIds);
    const { data, error } = clientIds.length
      ? await supabase
          .from("client_account_links")
          .select("client_id")
          .eq("studio_id", studioId)
          .eq("status", "linked")
          .in("client_id", clientIds)
      : { data: [], error: null };
    if (error) throw new Error(error.message);
    const linked = new Set(((data ?? []) as Row[]).map((row) => String(row.client_id)));
    return actions.flatMap((action) => {
      const clientId = action.related_id;
      const client = clientId ? clients.get(clientId) : undefined;
      if (!clientId || !client) return [];
      if (linked.has(clientId)) {
        return [complete(action, "account_linked", "Completed automatically: this client now has a linked DanceFlow account.")];
      }
      const status = norm(client.status);
      if (CLIENT_STATUSES.includes(status) && status !== "active") {
        return [complete(action, "client_not_active", `Completed automatically: this client is now ${status.replaceAll("_", " ")}.`, { client_status: status })];
      }
      return [];
    });
  },
};

/* --------------------------------------------- C: time-bound ---------------------------------------------------- */

const confirmationGapHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, now, actions }) {
    const rows = await loadById(supabase, "appointments", "id, status, starts_at", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const status = norm(row.status);
      // C3: rescheduled appointments still await client confirmation (CONFIRMABLE_STATUSES in appointmentConfirmation).
      if (["confirmed", "cancelled", "attended", "no_show"].includes(status)) {
        return [complete(action, "appointment_no_longer_unconfirmed", `Completed automatically: this appointment is now ${status.replaceAll("_", " ")}.`, { appointment_status: status })];
      }
      const startsAt = new Date(String(row.starts_at ?? "")).getTime();
      if (Number.isFinite(startsAt) && startsAt <= now.getTime()) {
        return [expire(action, "confirmation_window_passed", "Closed automatically: this appointment has started, so the confirmation window has passed.")];
      }
      return [];
    });
  },
};

const PROMOTION_MIN_REGISTRATIONS = 5;

async function activeRegistrationCounts(supabase: AnySupabaseClient, studioId: string, eventIds: string[]) {
  const counts = new Map<string, number>();
  if (eventIds.length === 0) return counts;
  const { data, error } = await supabase
    .from("event_registrations")
    .select("event_id, status, quantity")
    .eq("studio_id", studioId)
    .in("event_id", eventIds);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Row[]) {
    const status = norm(row.status);
    if (["waitlisted", "cancelled", "canceled", "declined", "refunded"].includes(status)) continue;
    const eventId = String(row.event_id);
    counts.set(eventId, (counts.get(eventId) ?? 0) + Math.max(1, num(row.quantity, 1)));
  }
  return counts;
}

function eventStarted(row: Row, now: Date) {
  const start = getEventStartUtc({
    start_date: (row.start_date as string | null) ?? null,
    start_time: (row.start_time as string | null) ?? null,
    end_date: (row.end_date as string | null) ?? (row.start_date as string | null) ?? null,
    end_time: (row.end_time as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
  });
  return start !== null && start.getTime() <= now.getTime();
}

const eventPromotionGapHandler: AriaLifecycleHandler = {
  relatedTable: "events",
  async resolve({ supabase, studioId, now, actions }) {
    const events = await studioEvents(supabase, studioId, ids(actions));
    const counts = await activeRegistrationCounts(supabase, studioId, Array.from(events.keys()));
    return actions.flatMap((action) => {
      const event = action.related_id ? events.get(action.related_id) : undefined;
      if (!event) return [];
      if (norm(event.status) === "cancelled") {
        return [complete(action, "event_cancelled", "Completed automatically: this event was cancelled.")];
      }
      if (eventStarted(event, now)) {
        return [expire(action, "promotion_window_passed", "Closed automatically: this event has started, so the promotion window has passed.")];
      }
      const registrations = counts.get(String(event.id)) ?? 0;
      if (registrations >= PROMOTION_MIN_REGISTRATIONS) {
        return [
          complete(action, "event_registrations_recovered", `Completed automatically: this event now has ${registrations} active registrations.`, {
            registrations,
          }),
        ];
      }
      return [];
    });
  },
};

const classCapacityHandler: AriaLifecycleHandler = {
  relatedTable: "events",
  async resolve({ supabase, studioId, now, actions }) {
    const events = await studioEvents(supabase, studioId, ids(actions));
    return actions.flatMap((action) => {
      const event = action.related_id ? events.get(action.related_id) : undefined;
      if (!event) return [];
      if (norm(event.status) === "cancelled") {
        return [complete(action, "event_cancelled", "Completed automatically: this class was cancelled.")];
      }
      if (eventStarted(event, now)) {
        return [expire(action, "capacity_window_passed", "Closed automatically: this class has started, so the capacity review window has passed.")];
      }
      return [];
    });
  },
};

/** Generator window: a cancellation is "recent" for two days after the cancelled appointment's start. */
export const ARIA_CANCELLATION_FOLLOW_UP_WINDOW_DAYS = 2;

const cancellationFollowUpHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, now, actions }) {
    const rows = await loadById(supabase, "appointments", "id, client_id, starts_at", studioId, ids(actions));
    const clientIds = Array.from(new Set(Array.from(rows.values()).map((row) => row.client_id).filter(Boolean))) as string[];
    const rebooked = await clientsWithFutureBooking(supabase, studioId, clientIds, now);
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      if (row.client_id && rebooked.has(String(row.client_id))) {
        return [complete(action, "client_rebooked", "Completed automatically: this client now has a future appointment.")];
      }
      const startsAt = new Date(String(row.starts_at ?? "")).getTime();
      const windowEnd = startsAt + ARIA_CANCELLATION_FOLLOW_UP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      if (Number.isFinite(startsAt) && windowEnd <= now.getTime()) {
        return [expire(action, "cancellation_window_passed", "Closed automatically: this is no longer a recent cancellation.")];
      }
      return [];
    });
  },
};

/* ------------------------------------------ D: outcome-dependent ------------------------------------------------ */

const membershipCancelingHandler: AriaLifecycleHandler = {
  relatedTable: "client_memberships",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "client_memberships", "id, status, cancel_at_period_end", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const status = norm(row.status);
      if (["cancelled", "expired"].includes(status)) {
        return [expire(action, "membership_ended", `Closed automatically: this membership has ${status === "expired" ? "expired" : "been cancelled"}, so the retention window has passed.`, { membership_status: status })];
      }
      if (row.cancel_at_period_end === false) {
        return [complete(action, "membership_retained", "Completed automatically: this membership is no longer set to cancel.")];
      }
      return [];
    });
  },
};

/** aria_stale_active_student and legacy no_upcoming_lesson: the claim is "no future appointment". */
function noFutureBookingHandler(options: { requireActiveClient: boolean; pendingRequestCounts: boolean }): AriaLifecycleHandler {
  return {
    relatedTable: "clients",
    async resolve({ supabase, studioId, now, actions }) {
      const clientIds = ids(actions);
      const clients = await loadById(supabase, "clients", "id, status", studioId, clientIds);
      const booked = await clientsWithFutureBooking(supabase, studioId, Array.from(clients.keys()), now);
      let pending = new Set<string>();
      if (options.pendingRequestCounts && clients.size > 0) {
        const { data, error } = await supabase
          .from("booking_requests")
          .select("client_id")
          .eq("studio_id", studioId)
          .eq("status", "pending")
          .in("client_id", Array.from(clients.keys()));
        if (error) throw new Error(error.message);
        pending = new Set(((data ?? []) as Row[]).map((row) => String(row.client_id)));
      }
      return actions.flatMap((action) => {
        const clientId = action.related_id;
        const client = clientId ? clients.get(clientId) : undefined;
        if (!clientId || !client) return [];
        if (booked.has(clientId)) {
          return [complete(action, "future_appointment_booked", "Completed automatically: this client now has a future appointment.")];
        }
        if (pending.has(clientId)) {
          return [complete(action, "booking_request_pending", "Completed automatically: this client has a booking request awaiting review.")];
        }
        const status = norm(client.status);
        if (options.requireActiveClient && CLIENT_STATUSES.includes(status) && status !== "active") {
          return [complete(action, "client_not_active", `Completed automatically: this client is now ${status.replaceAll("_", " ")}.`, { client_status: status })];
        }
        return [];
      });
    },
  };
}

/** Legacy first_lesson_follow_up: the hoped-for outcome is a next lesson after the first one. */
const firstLessonFollowUpHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, actions }) {
    const firstLessons = await loadById(supabase, "appointments", "id, client_id, starts_at", studioId, ids(actions));
    const clientIds = Array.from(new Set(Array.from(firstLessons.values()).map((row) => row.client_id).filter(Boolean))) as string[];
    if (clientIds.length === 0) return [];
    const { data, error } = await supabase
      .from("appointments")
      .select("id, client_id, status, starts_at")
      .eq("studio_id", studioId)
      .in("client_id", clientIds);
    if (error) throw new Error(error.message);
    const appointments = (data ?? []) as Row[];
    return actions.flatMap((action) => {
      const first = action.related_id ? firstLessons.get(action.related_id) : undefined;
      if (!first?.client_id) return [];
      const firstStart = String(first.starts_at ?? "");
      const next = appointments.find(
        (row) =>
          String(row.client_id) === String(first.client_id) &&
          String(row.id) !== String(first.id) &&
          String(row.starts_at ?? "") > firstStart &&
          BOOKED_APPOINTMENT_STATUSES.includes(norm(row.status)),
      );
      return next ? [complete(action, "next_lesson_booked", "Completed automatically: this client has booked another lesson.")] : [];
    });
  },
};

/* ------------------------------------- B / E: supersede or close contradicted facts -------------------------------- */

const eventLossHandler: AriaLifecycleHandler = {
  relatedTable: "events",
  async resolve({ supabase, studioId, actions }) {
    const events = await studioEvents(supabase, studioId, ids(actions));
    const profit = await profitRows(supabase, Array.from(events.keys()));
    return actions.flatMap((action) => {
      const event = action.related_id ? events.get(action.related_id) : undefined;
      const row = action.related_id ? profit.get(action.related_id) : undefined;
      if (!event || !row) return [];
      const profitLoss = num(row.event_profit_loss, Number.NaN);
      if (!Number.isFinite(profitLoss) || profitLoss < 0) return [];
      // Human-close: never auto-completed, but the "below break-even" claim is superseded with current facts.
      return [
        {
          actionId: action.id,
          kind: "refresh" as const,
          reason: "event_no_longer_below_break_even",
          note: "",
          evidence: { event_profit_loss: profitLoss },
          body: `${String(event.name ?? "This event")} is no longer below break-even on current figures (profit/loss $${profitLoss.toLocaleString("en-US")}). Review whether this item still needs attention before closing it.`,
        },
      ];
    });
  },
};

const IMPORT_BATCH_ATTENTION_STATUSES = ["failed", "completed_with_warnings"];

const dataQualityHandler: AriaLifecycleHandler = {
  relatedTable: "import_batches",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "import_batches", "id, source_system, import_type, status, failed_rows", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row || !row.status) return [];
      const status = norm(row.status);
      const failedRows = num(row.failed_rows, Number.NaN);
      if (!Number.isFinite(failedRows) || failedRows > 0 || IMPORT_BATCH_ATTENTION_STATUSES.includes(status)) return [];
      return [
        {
          actionId: action.id,
          kind: "refresh" as const,
          reason: "import_batch_no_longer_failing",
          note: "",
          evidence: { import_status: status, failed_rows: failedRows },
          body: `${String(row.source_system ?? "Imported")} ${String(row.import_type ?? "data")} batch now shows status ${status.replaceAll("_", " ")} with no failed rows. Confirm the imported records before closing this review.`,
        },
      ];
    });
  },
};

const noShowRecoveryHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "appointments", "id, status", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const status = norm(row.status);
      // Only the factual premise is checked: if attendance was corrected, the "no-show" claim is false.
      if (APPOINTMENT_STATUSES.includes(status) && status !== "no_show") {
        return [complete(action, "no_show_corrected", `Completed automatically: this appointment is no longer marked no-show (now ${status.replaceAll("_", " ")}).`, { appointment_status: status })];
      }
      return [];
    });
  },
};

const marketingDraftHandler: AriaLifecycleHandler = {
  relatedTable: "marketing_campaigns",
  async resolve({ supabase, studioId, actions }) {
    const rows = await loadById(supabase, "marketing_campaigns", "id, status", studioId, ids(actions));
    return actions.flatMap((action) => {
      const row = action.related_id ? rows.get(action.related_id) : undefined;
      if (!row) return [];
      const status = norm(row.status);
      if (["scheduled", "sending", "sent", "failed", "cancelled"].includes(status)) {
        return [complete(action, "campaign_no_longer_draft", `Completed automatically: this campaign is no longer a draft (now ${status}).`, { campaign_status: status })];
      }
      return [];
    });
  },
};

const inactiveReactivationHandler: AriaLifecycleHandler = {
  relatedTable: "clients",
  async resolve({ supabase, studioId, now, actions }) {
    const clients = await loadById(supabase, "clients", "id, status", studioId, ids(actions));
    const booked = await clientsWithFutureBooking(supabase, studioId, Array.from(clients.keys()), now);
    return actions.flatMap((action) => {
      const clientId = action.related_id;
      const client = clientId ? clients.get(clientId) : undefined;
      if (!clientId || !client) return [];
      const status = norm(client.status);
      if (CLIENT_STATUSES.includes(status) && status !== "inactive") {
        return [complete(action, "client_no_longer_inactive", `Completed automatically: this client is now ${status.replaceAll("_", " ")}.`, { client_status: status })];
      }
      if (booked.has(clientId)) {
        return [complete(action, "future_appointment_booked", "Completed automatically: this client now has a future appointment.")];
      }
      return [];
    });
  },
};

export const ARIA_LOW_CHECKIN_THRESHOLD = 0.75;

export function ariaLowCheckinBody(eventName: string, checkInRate: number) {
  return `${eventName} checked in ${Math.round(checkInRate * 100)}% of issued tickets. Review whether scans were missed, attendees no-showed, or reminder timing needs improvement.`;
}

const lowCheckinHandler: AriaLifecycleHandler = {
  relatedTable: "events",
  async resolve({ supabase, studioId, actions }) {
    const events = await studioEvents(supabase, studioId, ids(actions));
    const eventIds = Array.from(events.keys());
    if (eventIds.length === 0) return [];
    const [{ data: tickets, error: ticketsError }, { data: registrations, error: registrationsError }] = await Promise.all([
      supabase.from("event_registration_attendees").select("event_id, checked_in_at").in("event_id", eventIds),
      supabase.from("event_registrations").select("event_id, quantity").eq("studio_id", studioId).in("event_id", eventIds),
    ]);
    if (ticketsError || registrationsError) return []; // unreadable: ambiguous
    return actions.flatMap((action) => {
      const event = action.related_id ? events.get(action.related_id) : undefined;
      if (!event) return [];
      const eventTickets = ((tickets ?? []) as Row[]).filter((row) => String(row.event_id) === String(event.id));
      const issued =
        eventTickets.length ||
        ((registrations ?? []) as Row[])
          .filter((row) => String(row.event_id) === String(event.id))
          .reduce((sum, row) => sum + Math.max(1, num(row.quantity, 1)), 0);
      if (issued <= 0) return [];
      const rate = eventTickets.filter((row) => row.checked_in_at).length / issued;
      if (rate >= ARIA_LOW_CHECKIN_THRESHOLD) {
        return [complete(action, "checkin_rate_recovered", `Completed automatically: check-in is now ${Math.round(rate * 100)}% of issued tickets.`, { checkin_rate: rate })];
      }
      return [
        {
          actionId: action.id,
          kind: "refresh" as const,
          reason: "checkin_rate_updated",
          note: "",
          evidence: { checkin_rate: rate },
          body: ariaLowCheckinBody(String(event.name ?? "This event"), rate),
        },
      ];
    });
  },
};

/*
  Cleanup PR C3: aria_schedule_conflict. The action is anchored to ONE appointment of an overlapping pair (related_id);
  the other appointment is not stored. Reconciliation therefore never guesses the original pair. It re-runs the
  generator's own conflict definition for the anchor against current data -- other UPCOMING appointments of the studio,
  not cancelled / declined / no-show, overlapping in time and sharing the instructor or the room -- and:
    - completes when the anchor has NO remaining conflict at all (so the original pair cannot still conflict);
    - completes when the anchor itself was cancelled / declined / marked no-show;
    - expires once the anchor has started (the generator only considers upcoming appointments);
    - otherwise leaves the action open, even if the conflicting appointment is now a different one (generation then
      refreshes the wording to the current conflict).
  The conflict search is exact for the anchor's time range (starts from now up to the anchor's end), not a bounded batch.
*/
const SCHEDULE_CONFLICT_EXCLUDED_STATUSES = ["cancelled", "canceled", "declined", "no_show"];

function appointmentWindow(row: Row) {
  const start = new Date(String(row.starts_at ?? "")).getTime();
  const end = new Date(String(row.ends_at ?? row.starts_at ?? "")).getTime();
  return { start, end };
}

const scheduleConflictHandler: AriaLifecycleHandler = {
  relatedTable: "appointments",
  async resolve({ supabase, studioId, now, actions }) {
    const anchors = await loadById(supabase, "appointments", "id, status, instructor_id, room_id, starts_at, ends_at", studioId, ids(actions));
    const resolutions: AriaActionResolution[] = [];
    for (const action of actions) {
      const anchor = action.related_id ? anchors.get(action.related_id) : undefined;
      if (!anchor) continue;
      const { start, end } = appointmentWindow(anchor);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const status = norm(anchor.status);
      if (SCHEDULE_CONFLICT_EXCLUDED_STATUSES.includes(status)) {
        resolutions.push(complete(action, "conflict_appointment_cancelled", `Completed automatically: this appointment is now ${status.replaceAll("_", " ")}, so the conflict no longer applies.`, { appointment_status: status }));
        continue;
      }
      if (start <= now.getTime()) {
        resolutions.push(expire(action, "conflict_window_passed", "Closed automatically: this appointment has started, so the scheduling conflict can no longer be resolved in advance."));
        continue;
      }
      if (!anchor.instructor_id && !anchor.room_id) {
        resolutions.push(complete(action, "conflict_resources_cleared", "Completed automatically: this appointment no longer shares an instructor or room with another booking."));
        continue;
      }
      const { data, error } = await supabase
        .from("appointments")
        .select("id, status, instructor_id, room_id, starts_at, ends_at")
        .eq("studio_id", studioId)
        .gte("starts_at", now.toISOString())
        .lt("starts_at", new Date(Math.max(end, start + 1)).toISOString());
      if (error) throw new Error(error.message);
      const stillConflicts = ((data ?? []) as Row[]).some((other) => {
        if (String(other.id) === String(anchor.id)) return false;
        if (SCHEDULE_CONFLICT_EXCLUDED_STATUSES.includes(norm(other.status))) return false;
        const window = appointmentWindow(other);
        if (!Number.isFinite(window.start) || !Number.isFinite(window.end)) return false;
        const overlaps = start < window.end && window.start < end;
        if (!overlaps) return false;
        const sameInstructor = Boolean(anchor.instructor_id && other.instructor_id && anchor.instructor_id === other.instructor_id);
        const sameRoom = Boolean(anchor.room_id && other.room_id && anchor.room_id === other.room_id);
        return sameInstructor || sameRoom;
      });
      if (!stillConflicts) {
        resolutions.push(complete(action, "conflict_cleared", "Completed automatically: this appointment no longer overlaps another upcoming booking for the same instructor or room."));
      }
    }
    return resolutions;
  },
};

/** Registry for the remaining 28 rules (C2: 27; C3: aria_schedule_conflict). */
export const ARIA_C2_LIFECYCLE_HANDLERS: Record<string, AriaLifecycleHandler> = {
  // A
  aria_document_expiration: documentHandler({ dueDateMatters: true }),
  unsigned_document: documentHandler({ dueDateMatters: false }),
  aria_order_fulfillment_exception: orderFulfillmentHandler,
  aria_event_unpaid_registration: eventUnpaidRegistrationHandler,
  aria_instructor_coverage_gap: instructorCoverageHandler,
  aria_lead_follow_up_sequence: leadActivityHandler,
  aria_staff_task_reminder: leadActivityHandler,
  aria_lead_acknowledgement: leadAcknowledgementHandler,
  aria_inventory_low_stock: inventoryHandler,
  aria_payroll_missing_data: payrollSetupHandler,
  aria_event_missing_costs: eventMissingCostsHandler,
  aria_student_app_adoption: studentAppAdoptionHandler,
  // C
  aria_appointment_confirmation_gap: confirmationGapHandler,
  aria_event_promotion_gap: eventPromotionGapHandler,
  aria_class_capacity: classCapacityHandler,
  aria_cancellation_follow_up: cancellationFollowUpHandler,
  // D
  aria_membership_canceling: membershipCancelingHandler,
  aria_stale_active_student: noFutureBookingHandler({ requireActiveClient: true, pendingRequestCounts: false }),
  no_upcoming_lesson: noFutureBookingHandler({ requireActiveClient: false, pendingRequestCounts: true }),
  first_lesson_follow_up: firstLessonFollowUpHandler,
  // B
  aria_event_loss: eventLossHandler,
  aria_data_quality_exception: dataQualityHandler,
  // E
  aria_no_show_service_recovery: noShowRecoveryHandler,
  aria_marketing_opportunity: marketingDraftHandler,
  aria_inactive_client_reactivation: inactiveReactivationHandler,
  aria_event_low_checkin: lowCheckinHandler,
  // C3
  aria_schedule_conflict: scheduleConflictHandler,
};
