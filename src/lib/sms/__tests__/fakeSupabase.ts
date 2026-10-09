/**
 * A2P-1A test support: a tiny in-memory stand-in for the Supabase query builder,
 * covering only the calls the SMS routes and dispatcher make. Not a test file itself.
 */

export type FakeRow = Record<string, unknown>;

export type FakeMutation = {
  table: string;
  op: "insert" | "update" | "delete";
  values: unknown;
  ids: string[];
};

type Mode = "many" | "single" | "maybe";

export function createFakeSupabase(seed: Record<string, FakeRow[]> = {}) {
  const tables = new Map<string, FakeRow[]>(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
  );
  const mutations: FakeMutation[] = [];
  let idSequence = 0;

  function table(name: string) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(name: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let values: unknown = null;
    let returning = false;
    let limitCount: number | null = null;
    let orderSpec: { column: string; ascending: boolean } | null = null;

    async function execute(mode: Mode) {
      const rows = table(name);
      let result: FakeRow[] = [];

      if (op === "insert") {
        const list = (Array.isArray(values) ? values : [values]).map((value) => ({
          id: `${name}-${++idSequence}`,
          ...(value as FakeRow),
        }));
        rows.push(...list);
        mutations.push({ table: name, op, values, ids: list.map((row) => String(row.id)) });
        result = list;

        if (!returning && mode === "many") return { data: null, error: null };
      } else if (op === "update") {
        result = rows.filter((row) => filters.every((filter) => filter(row)));
        result.forEach((row) => Object.assign(row, values as FakeRow));
        mutations.push({ table: name, op, values, ids: result.map((row) => String(row.id)) });
      } else if (op === "delete") {
        result = rows.filter((row) => filters.every((filter) => filter(row)));
        tables.set(name, rows.filter((row) => !result.includes(row)));
        mutations.push({ table: name, op, values: null, ids: result.map((row) => String(row.id)) });
      } else {
        result = rows.filter((row) => filters.every((filter) => filter(row)));

        if (orderSpec) {
          const { column, ascending } = orderSpec;
          result = [...result].sort((a, b) => {
            const left = String(a[column] ?? "");
            const right = String(b[column] ?? "");
            return ascending ? left.localeCompare(right) : right.localeCompare(left);
          });
        }

        if (limitCount !== null) result = result.slice(0, limitCount);
        result = result.map((row) => ({ ...row }));
      }

      if (mode === "single") {
        return result.length > 0
          ? { data: result[0], error: null }
          : { data: null, error: { message: "No rows found" } };
      }

      if (mode === "maybe") return { data: result[0] ?? null, error: null };

      return { data: result, error: null };
    }

    const passthrough = () => builder;

    const builder = {
      select() {
        if (op !== "select") returning = true;
        return builder;
      },
      insert(value: unknown) {
        op = "insert";
        values = value;
        return builder;
      },
      update(value: unknown) {
        op = "update";
        values = value;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push((row) => row[column] !== value);
        return builder;
      },
      in(column: string, list: unknown[]) {
        filters.push((row) => list.includes(row[column]));
        return builder;
      },
      not: passthrough,
      is: passthrough,
      lt: passthrough,
      lte: passthrough,
      gt: passthrough,
      gte: passthrough,
      order(column: string, options: { ascending?: boolean } = {}) {
        orderSpec = { column, ascending: options.ascending ?? true };
        return builder;
      },
      limit(count: number) {
        limitCount = count;
        return builder;
      },
      single: () => execute("single"),
      maybeSingle: () => execute("maybe"),
      then<T>(
        resolve: (value: Awaited<ReturnType<typeof execute>>) => T,
        reject?: (reason: unknown) => T,
      ) {
        return execute("many").then(resolve, reject);
      },
    };

    return builder;
  }

  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcOverrides = new Map<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>();

  function record(op: FakeMutation["op"], name: string, values: unknown, rows: FakeRow[]) {
    mutations.push({ table: name, op, values, ids: rows.map((row) => String(row.id)) });
  }

  function updateRows(rows: FakeRow[], values: FakeRow) {
    rows.forEach((row) => Object.assign(row, values));
    if (rows.length > 0) record("update", "sms_contact_permissions", values, rows);
    return rows.length;
  }

  const hasIdentity = (row: FakeRow) => row.client_id != null || row.organizer_contact_id != null;
  const consumerOptedOut = (row: FakeRow) =>
    row.consent_status === "opted_out" && row.opted_out_source === "twilio_inbound_stop";

  /**
   * TW-2 test double for the consumer-path consent functions. It follows the contract of
   * record_sms_inbound_opt_event / record_sms_public_opt_in (current-state effects and
   * return values); the real behavior, atomic history and authorization are proven by
   * sql-tests/test_T_twilio_tw2_consent_integrity.sql.
   */
  const rpcEmulators: Record<string, (args: Record<string, unknown>) => unknown> = {
    record_sms_inbound_opt_event(args) {
      const studioId = args.p_studio_id;
      const phone = args.p_phone_e164;
      const now = new Date().toISOString();
      const rows = table("sms_contact_permissions").filter(
        (row) => row.studio_id === studioId && row.phone_e164 === phone,
      );

      if (args.p_event === "stop") {
        const changed = updateRows(
          rows.filter((row) => hasIdentity(row) && !consumerOptedOut(row)),
          { consent_status: "opted_out", opted_out_at: now, opted_out_source: "twilio_inbound_stop", updated_by: null },
        );
        const phoneLevel = rows.find((row) => !hasIdentity(row));
        let phoneLevelChanged = 0;
        if (!phoneLevel) {
          const inserted: FakeRow = {
            id: `sms_contact_permissions-${++idSequence}`,
            studio_id: studioId,
            organizer_id: null,
            client_id: null,
            organizer_contact_id: null,
            phone_e164: phone,
            consent_status: "opted_out",
            consent_at: null,
            opted_out_at: now,
            opted_out_source: "twilio_inbound_stop",
          };
          table("sms_contact_permissions").push(inserted);
          record("insert", "sms_contact_permissions", inserted, [inserted]);
          phoneLevelChanged = 1;
        } else if (!consumerOptedOut(phoneLevel)) {
          phoneLevelChanged = updateRows([phoneLevel], {
            consent_status: "opted_out",
            opted_out_at: now,
            opted_out_source: "twilio_inbound_stop",
          });
        }
        return { event: "stop", rows_changed: changed, phone_level_changed: phoneLevelChanged };
      }

      const restored = updateRows(
        rows.filter((row) => hasIdentity(row) && row.consent_status === "opted_out" && row.consent_at != null),
        {
          consent_status: "opted_in",
          consent_at: now,
          consent_source: "twilio_inbound_start",
          opted_out_at: null,
          opted_out_source: null,
          updated_by: null,
        },
      );
      const lifted = updateRows(
        rows.filter((row) => !hasIdentity(row) && row.consent_status === "opted_out"),
        { consent_status: "unknown", opted_out_at: null, opted_out_source: null, updated_by: null },
      );
      return { event: "start", rows_changed: restored, phone_level_changed: lifted };
    },

    record_sms_public_opt_in(args) {
      const rows = table("sms_contact_permissions").filter(
        (row) => row.studio_id === args.p_studio_id && row.phone_e164 === args.p_phone_e164,
      );
      if (rows.some((row) => row.consent_status === "opted_out")) return "opted_out";

      const existing = rows.find((row) => row.client_id === args.p_client_id);
      if (existing?.consent_status === "opted_in") return "already_opted_in";

      const evidence = {
        consent_status: "opted_in",
        consent_source: args.p_source,
        consent_at: new Date().toISOString(),
        consent_note: args.p_note ?? null,
        opted_out_at: null,
        opted_out_source: null,
        updated_by: null,
      };

      if (existing) {
        return updateRows([existing], evidence) === 1 ? "upgraded" : "duplicate";
      }

      const inserted: FakeRow = {
        id: `sms_contact_permissions-${++idSequence}`,
        studio_id: args.p_studio_id,
        organizer_id: null,
        client_id: args.p_client_id,
        organizer_contact_id: null,
        phone_e164: args.p_phone_e164,
        created_by: null,
        ...evidence,
      };
      table("sms_contact_permissions").push(inserted);
      record("insert", "sms_contact_permissions", inserted, [inserted]);
      return "inserted";
    },
  };

  async function rpc(name: string, args: Record<string, unknown> = {}) {
    rpcCalls.push({ name, args });
    const override = rpcOverrides.get(name);
    if (override) return override(args);
    const emulate = rpcEmulators[name];
    if (!emulate) return { data: null, error: { code: "PGRST202", message: `unknown function ${name}` } };
    return { data: emulate(args), error: null };
  }

  return {
    client: { from, rpc },
    tables,
    mutations,
    rpcCalls,
    /** Replace one RPC's behavior (e.g. to inject a database error). */
    overrideRpc(name: string, handler: (args: Record<string, unknown>) => { data: unknown; error: unknown }) {
      rpcOverrides.set(name, handler);
    },
    rows(name: string) {
      return table(name);
    },
  };
}
