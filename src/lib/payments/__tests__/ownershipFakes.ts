/**
 * PAY-DC-2A test fakes: a minimal in-memory Supabase query builder (with `.is()` and
 * the stripe_account_id immutability trigger emulated) and a Stripe call recorder.
 */

import { applyRefundReconciliation, type RefundRpcCall } from "./refundReconciliationRpcFake";

export type Row = Record<string, unknown>;
export type Mutation = {
  table: string;
  op: "insert" | "update";
  values: Row;
  ids: string[];
  client: "user" | "admin";
};

/** Returns an error message to reject a tenant (user-client) row write, else null. */
export type RowGuard = (table: string, before: Row | null, after: Row) => string | null;

export function createOwnershipFakeSupabase(
  seed: Record<string, Row[]> = {},
  options: {
    rowGuard?: RowGuard;
    /** Returns a result to replace an RPC call (e.g. to inject a failure); undefined falls through. */
    rpcOverride?: (name: string, params: Row) => { data: unknown; error: { message: string } | null } | undefined;
  } = {},
) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  const mutations: Mutation[] = [];
  const fromCalls: string[] = [];

  function makeFrom(clientKind: "user" | "admin") {
    return (table: string) => from(table, clientKind);
  }

  function from(table: string, clientKind: "user" | "admin" = "user") {
    const guard = clientKind === "user" ? options.rowGuard : undefined;
    fromCalls.push(table);
    tables[table] ??= [];
    let op: "select" | "insert" | "update" = "select";
    let values: Row | Row[] | null = null;
    let limitCount: number | null = null;
    const filters: Array<(row: Row) => boolean> = [];

    const exec = (mode: "many" | "single" | "maybeSingle") => {
      const rows = tables[table];

      if (op === "insert") {
        const list = (Array.isArray(values) ? values : [values ?? {}]).map((row, index) => ({
          id: `${table}-new-${rows.length + index + 1}`,
          ...row,
        }));
        for (const row of list) {
          const rejection = guard?.(table, null, row);
          if (rejection) {
            return Promise.resolve({ data: null, error: { message: rejection, code: "42501" } });
          }
        }
        rows.push(...list);
        mutations.push({ table, op, values: { ...list[0] }, ids: list.map((row) => String(row.id)), client: clientKind });
        return result(list, mode);
      }

      const filtered = rows.filter((row) => filters.every((filter) => filter(row)));
      const matched = limitCount == null ? filtered : filtered.slice(0, limitCount);

      if (op === "update") {
        const patch = (values ?? {}) as Row;
        for (const row of matched) {
          const rejection = guard?.(table, row, { ...row, ...patch });
          if (rejection) {
            return Promise.resolve({ data: null, error: { message: rejection, code: "42501" } });
          }
        }
        if ("stripe_account_id" in patch) {
          const blocked = matched.some(
            (row) =>
              row.stripe_account_id != null && row.stripe_account_id !== patch.stripe_account_id,
          );
          if (blocked) {
            return Promise.resolve({
              data: null,
              error: { message: "stripe_account_id is immutable once set", code: "23514" },
            });
          }
        }
        for (const row of matched) Object.assign(row, patch);
        mutations.push({ table, op, values: patch, ids: matched.map((row) => String(row.id)), client: clientKind });
      }

      return result(matched, mode);
    };

    const result = (rows: Row[], mode: "many" | "single" | "maybeSingle") => {
      if (mode === "many") return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null });
      const first = rows[0] ? { ...rows[0] } : null;
      if (mode === "single" && !first) {
        return Promise.resolve({ data: null, error: { message: "not found", code: "PGRST116" } });
      }
      return Promise.resolve({ data: first, error: null });
    };

    const builder = {
      select: () => builder,
      insert: (value: Row | Row[]) => {
        op = "insert";
        values = value;
        return builder;
      },
      update: (value: Row) => {
        op = "update";
        values = value;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in: (column: string, list: unknown[]) => {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      // PostgREST `or` with `column.eq.value`, `column.is.null` and `column.lte.value` terms (e.g. "a.eq.x,b.is.null").
      or: (expression: string) => {
        const terms = expression.split(",").map((term) => {
          const [column, operator, ...rest] = term.split(".");
          if (operator !== "eq" && operator !== "is" && operator !== "lte") {
            throw new Error(`ownership fake: unsupported or() operator ${operator}`);
          }
          return { column, operator, value: rest.join(".") };
        });
        // A null/absent column never equals or compares to any value, as in PostgreSQL (`col.eq.` must not match NULL).
        filters.push((row) =>
          terms.some((term) => {
            const cell = row[term.column];
            if (term.operator === "is") return term.value === "null" && cell == null;
            if (cell == null) return false;
            if (term.operator === "lte") return new Date(String(cell)).getTime() <= new Date(term.value).getTime();
            return String(cell) === term.value;
          }),
        );
        return builder;
      },
      is: (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return builder;
      },
      order: () => builder,
      limit: (count: number) => {
        limitCount = count;
        return builder;
      },
      single: () => exec("single"),
      maybeSingle: () => exec("maybeSingle"),
      then: (
        resolve: (value: { data: unknown; error: { message: string; code?: string } | null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => exec("many").then(resolve, reject),
    };

    return builder;
  }

  /** Mirror of public.apply_studio_subscription_state (BILLING-QA-6); the real function is tested in sql-tests against Postgres. */
  function applyStudioSubscriptionState(params: Row) {
    const studioId = String(params.p_studio_id);
    const sub = (params.p_subscription ?? {}) as Row;
    const snap = (params.p_snapshot ?? {}) as Row;
    const addon = (params.p_addon ?? null) as { active?: boolean; item_ids?: string[] } | null;
    const readAt = params.p_read_started_at ? new Date(String(params.p_read_started_at)).getTime() : null;
    const studios = (tables.studios ??= []);
    const studio = studios.find((row) => row.id === studioId);
    if (!studio) return { data: null, error: { message: `apply_studio_subscription_state: studio ${studioId} not found` } };
    const subs = (tables.studio_subscriptions ??= []);
    const existing = subs.find((row) => row.studio_id === studioId);
    const watermark = existing?.stripe_state_read_at ? new Date(String(existing.stripe_state_read_at)).getTime() : null;
    if (existing && readAt != null && watermark != null && watermark > readAt) return { data: "stale", error: null };

    const nowIso = new Date().toISOString();
    const subValues: Row = {
      subscription_plan_id: sub.subscription_plan_id,
      stripe_subscription_id: sub.stripe_subscription_id,
      status: sub.status,
      billing_interval: sub.billing_interval,
      current_period_start: sub.current_period_start ?? null,
      current_period_end: sub.current_period_end ?? null,
      cancel_at_period_end: Boolean(sub.cancel_at_period_end),
      cancelled_at: sub.cancelled_at ?? null,
      ended_at: sub.ended_at ?? null,
      updated_at: nowIso,
      ...(readAt != null ? { stripe_state_read_at: new Date(readAt).toISOString() } : {}),
    };
    if (existing) {
      Object.assign(existing, subValues);
      mutations.push({ table: "studio_subscriptions", op: "update", values: subValues, ids: [String(existing.id)], client: "admin" });
    } else {
      const created: Row = { id: `studio_subscriptions-new-${subs.length + 1}`, studio_id: studioId, ...subValues, created_at: nowIso };
      subs.push(created);
      mutations.push({ table: "studio_subscriptions", op: "insert", values: { ...created }, ids: [String(created.id)], client: "admin" });
    }

    const snapshotValues: Row = {
      stripe_customer_id: snap.stripe_customer_id,
      stripe_subscription_id: snap.stripe_subscription_id,
      subscription_status: snap.subscription_status,
      trial_ends_at: snap.trial_ends_at ?? null,
      updated_at: nowIso,
    };
    Object.assign(studio, snapshotValues);
    mutations.push({ table: "studios", op: "update", values: snapshotValues, ids: [studioId], client: "admin" });
    if (snap.billing_plan && !studio.billing_override_enabled) {
      studio.billing_plan = snap.billing_plan;
      mutations.push({ table: "studios", op: "update", values: { billing_plan: snap.billing_plan }, ids: [studioId], client: "admin" });
    }

    if (addon) {
      const entitlements = (tables.usage_addon_entitlements ??= []);
      const active = Boolean(addon.active);
      const itemIds = addon.item_ids ?? [];
      for (const itemId of itemIds) {
        const values: Row = {
          workspace_type: "studio", source: "stripe_subscription_item", stripe_subscription_item_id: itemId,
          quantity_included: 1, status: active ? "active" : "canceled", updated_at: nowIso,
        };
        const row = entitlements.find((e) => e.studio_id === studioId && e.feature_key === "organizer_suite");
        if (row) {
          Object.assign(row, values);
          mutations.push({ table: "usage_addon_entitlements", op: "update", values, ids: [String(row.id)], client: "admin" });
        } else {
          const created: Row = { id: `usage_addon_entitlements-new-${entitlements.length + 1}`, studio_id: studioId, feature_key: "organizer_suite", ...values };
          entitlements.push(created);
          mutations.push({ table: "usage_addon_entitlements", op: "insert", values: { ...created }, ids: [String(created.id)], client: "admin" });
        }
      }
      for (const row of entitlements) {
        const stale =
          row.studio_id === studioId && row.feature_key === "organizer_suite" && row.source === "stripe_subscription_item" &&
          row.status === "active" && (!row.stripe_subscription_item_id || !itemIds.includes(String(row.stripe_subscription_item_id)) || !active);
        if (stale) {
          Object.assign(row, { status: "canceled", updated_at: nowIso });
          mutations.push({ table: "usage_addon_entitlements", op: "update", values: { status: "canceled" }, ids: [String(row.id)], client: "admin" });
        }
      }
    }
    return { data: "applied", error: null };
  }

  const rpcCalls: Array<{ name: string; params: Row }> = [];
  async function rpc(name: string, params: Row) {
    rpcCalls.push({ name, params });
    const overridden = options.rpcOverride?.(name, params);
    if (overridden) return overridden;
    if (name === "apply_studio_subscription_state") return applyStudioSubscriptionState(params);
    if (name === "_apply_payment_refund_and_reevaluate") {
      // REFUND-RECON-1: the repaired RPC contract applied to these in-memory tables.
      return applyRefundReconciliation(
        {
          payments: (tables.payments ??= []),
          holds: tables.group_class_enrollment_holds,
          attendees: tables.appointment_attendees,
          attendance: tables.attendance_records,
          packages: tables.client_packages,
          conflicts: (tables.payment_settlement_conflicts ??= []),
        },
        params as unknown as RefundRpcCall,
      );
    }
    return { data: [{ applied: true }], error: null };
  }

  return {
    client: { from: makeFrom("user"), rpc },
    /** Service-role client: bypasses rowGuard (as service_role passes the DB guards). */
    adminClient: { from: makeFrom("admin"), rpc },
    tables,
    mutations,
    rpcCalls,
    fromCalls,
    rows: (table: string) => tables[table] ?? [],
  };
}

export type StripeCall = { method: string; args: unknown[] };

export function stripeError(fields: { code?: string; statusCode?: number; type?: string }) {
  return Object.assign(new Error("stripe error text that must never reach the UI acct_SECRET"), fields);
}

/**
 * Records every Stripe call. Objects are "found" only on the account listed in
 * `objectAccounts` (object id -> owning account); any other account gets a 404.
 */
export function createStripeRecorder(options: {
  objectAccounts?: Record<string, string>;
  refundError?: unknown;
  retrieveError?: unknown;
} = {}) {
  const calls: StripeCall[] = [];
  const objectAccounts = options.objectAccounts ?? {};

  const retrieve = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (options.retrieveError) throw options.retrieveError;
    const id = String(args[0]);
    const account = (args[2] as { stripeAccount?: string } | undefined)?.stripeAccount;
    if (!account || objectAccounts[id] !== account) {
      throw stripeError({ code: "resource_missing", statusCode: 404, type: "StripeInvalidRequestError" });
    }
    return { id };
  };

  const stripe = {
    paymentIntents: { retrieve: retrieve("paymentIntents.retrieve") },
    charges: { retrieve: retrieve("charges.retrieve") },
    refunds: {
      create: async (...args: unknown[]) => {
        calls.push({ method: "refunds.create", args });
        if (options.refundError) throw options.refundError;
        const params = (args[0] ?? {}) as { amount?: number };
        return { id: "re_test_1", status: "succeeded", amount: params.amount };
      },
    },
  };

  return {
    stripe,
    calls,
    accountsUsed: () =>
      calls.map((call) => (call.args[call.args.length - 1] as { stripeAccount?: string } | undefined)?.stripeAccount),
  };
}
