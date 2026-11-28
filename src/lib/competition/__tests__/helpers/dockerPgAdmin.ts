import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * CF1 database-backed settlement QA helper. LOCAL QA ONLY.
 *
 * Talks to ONE disposable Postgres container (name must start with "df-cf1r1-"; set CF1_DBQA_CONTAINER) through `docker exec ... psql`.
 * Every call is its own psql process, i.e. its own real database connection, so "concurrent" tests are genuinely concurrent backends.
 * Nothing here opens a network socket, reads a secret, or reaches Stripe, PostgREST or any hosted database. PostgREST is never involved
 * (calling revoked service functions through it is a known segfault on the local image); RPCs run as `set role service_role`, the same
 * role the production service key maps to, so grants are exercised too.
 *
 * `createShimAdmin()` implements exactly the supabase-js surface the competition settlement code uses (`rpc`, and a small `from().select()` filter
 * chain used by the repair lister). Unsupported shapes throw, so a code change that starts using more of the client fails loudly.
 */

/** Same pinning idea as e2e/helpers/qaDbContainer.ts: only a container created by scripts/qa/cf1-db-settlement.mjs is accepted. */
export const CF1_DBQA_PREFIX = "df-cf1r1-";
export const QA_CONTAINER = process.env.CF1_DBQA_CONTAINER ?? "";
export const dbQaEnabled = new RegExp(`^${CF1_DBQA_PREFIX}[a-z0-9-]{1,40}$`).test(QA_CONTAINER);

export type PsqlResult = { out: string; err: string; code: number };

export function runPsql(sql: string, options: { role?: string } = {}): Promise<PsqlResult> {
  if (!dbQaEnabled) throw new Error("CF1_DBQA_CONTAINER is not set to a df-cf1r1-* container.");
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", "-i", QA_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ out: out.trim(), err: err.trim(), code: code ?? -1 }));
    child.stdin.end(`${options.role ? `set role ${options.role};\n` : ""}${sql}\n`);
  });
}

function errorMessage(err: string) {
  const match = /ERROR:\s+([^\n]*)/.exec(err);
  return match ? match[1] : err || "psql failed";
}

/** Run SQL as the superuser (fixtures, inspection). Throws on error. */
export async function sql(statement: string) {
  const r = await runPsql(statement);
  if (r.code !== 0) throw new Error(`sql failed: ${errorMessage(r.err)}\n${statement.slice(0, 300)}`);
  return r.out;
}

export async function rows<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const out = await sql(`select coalesce(jsonb_agg(t), '[]'::jsonb)::text from (${query}) t;`);
  return JSON.parse(out) as T[];
}

export async function scalar<T = string>(query: string): Promise<T> {
  const out = await sql(`select to_jsonb(x)::text from (${query}) x(v);`);
  return (JSON.parse(out) as T);
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number argument");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

/** Call a public function as service_role; returns the supabase-js shape { data, error }. */
export async function callRpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
  const named = Object.entries(args).map(([k, v]) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`bad argument name ${k}`);
    return `${k} => ${literal(v)}`;
  }).join(", ");
  const r = await runPsql(`select to_jsonb(public.${fn}(${named}))::text;`, { role: "service_role" });
  if (r.code !== 0) return { data: null, error: { message: errorMessage(r.err) } };
  const text = r.out.split("\n").pop() ?? "null";
  return { data: JSON.parse(text), error: null };
}

const COLUMN = /^[a-z_][a-z0-9_]*(->>[a-z_][a-z0-9_]*)?$/;
function column(expression: string) {
  const name = expression.trim();
  if (!COLUMN.test(name)) throw new Error(`unsupported column expression ${expression}`);
  const [base, key] = name.split("->>");
  return key ? `${base}->>'${key}'` : base;
}

class ShimQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private columns = "*";
  private filters: string[] = [];
  private ordering: string[] = [];
  private max: number | null = null;
  constructor(private readonly table: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`bad table ${table}`);
  }
  select(columns: string) { this.columns = columns.split(",").map(column).join(", "); return this; }
  eq(col: string, value: unknown) { this.filters.push(`${column(col)} = ${literal(value)}`); return this; }
  not(col: string, op: string, value: unknown) {
    if (op !== "is" || value !== null) throw new Error("only .not(col, 'is', null) is supported");
    this.filters.push(`${column(col)} is not null`);
    return this;
  }
  lt(col: string, value: unknown) { this.filters.push(`${column(col)} < ${literal(value)}`); return this; }
  gt(col: string, value: unknown) { this.filters.push(`${column(col)} > ${literal(value)}`); return this; }
  order(col: string, opts: { ascending?: boolean } = {}) { this.ordering.push(`${column(col)} ${opts.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n: number) { this.max = Math.trunc(n); return this; }
  then<R1, R2>(onfulfilled?: ((v: { data: unknown; error: { message: string } | null }) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null) {
    return this.run().then(onfulfilled, onrejected);
  }
  private async run() {
    const where = this.filters.length ? ` where ${this.filters.join(" and ")}` : "";
    const order = this.ordering.length ? ` order by ${this.ordering.join(", ")}` : "";
    const limit = this.max !== null ? ` limit ${this.max}` : "";
    const r = await runPsql(`select coalesce(jsonb_agg(t), '[]'::jsonb)::text from (select ${this.columns} from public.${this.table}${where}${order}${limit}) t;`, { role: "service_role" });
    if (r.code !== 0) return { data: null, error: { message: errorMessage(r.err) } };
    return { data: JSON.parse(r.out.split("\n").pop() ?? "[]"), error: null };
  }
}

export type RpcCall = { fn: string; args: Record<string, unknown> };

/** The admin client stand-in: real SQL over real connections. `calls` records every RPC for assertions. */
export function createShimAdmin() {
  const calls: RpcCall[] = [];
  return {
    calls,
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      calls.push({ fn, args });
      return callRpc(fn, args);
    },
    from: (table: string) => new ShimQuery(table),
    count: (fn: string) => calls.filter((c) => c.fn === fn).length,
  };
}

/* ---------------------------------------------------------------------------------------------------------------------------------- */
/* Fixtures                                                                                                                            */
/* ---------------------------------------------------------------------------------------------------------------------------------- */

export type SeedOptions = {
  totalCents?: number;
  currency?: string;
  /** null = no bound Checkout Session yet. */
  sessionId?: string | null;
  accountId?: string | null;
  status?: "pending" | "confirmed" | "cancelled" | "expired";
  paymentStatus?: "pending" | "paid" | "unpaid" | "failed";
  /** event_orders.metadata.source; null leaves it out (an ordinary, non-competition order). */
  source?: string | null;
  requiresSigning?: boolean;
  /** Minutes since the order last changed (event_orders.updated_at). Default 60. */
  ageMinutes?: number;
  /** Whether the studio row carries the order's account as its connected account. Default true. */
  studioHasAccount?: boolean;
};

export type SeededOrder = {
  orderId: string;
  registrationId: string;
  studioId: string;
  eventId: string;
  sessionId: string | null;
  accountId: string | null;
  totalCents: number;
  currency: string;
};

const rand = () => randomBytes(5).toString("hex");

/**
 * One studio + event + pending competition-style order (+ its registration). Rows are inserted directly (the order-creation path itself is
 * covered by sql-tests/test_T_phase10c_competitor_registration.sql); what these tests need is the settlement-relevant state:
 * binding (session + connected account in metadata), price snapshot, status, signing flag and age.
 */
export async function seedOrder(options: SeedOptions = {}): Promise<SeededOrder> {
  const tag = rand();
  const orderId = randomUUID();
  const registrationId = randomUUID();
  const studioId = randomUUID();
  const eventId = randomUUID();
  const totalCents = options.totalCents ?? 10330;
  const currency = options.currency ?? "USD";
  const sessionId = options.sessionId === undefined ? `cs_test_${tag}` : options.sessionId;
  const accountId = options.accountId === undefined ? `acct_cf1r1${tag}` : options.accountId;
  const status = options.status ?? "pending";
  const paymentStatus = options.paymentStatus ?? "pending";
  const source = options.source === undefined ? "competition_registration" : options.source;
  const metadata: Record<string, unknown> = {};
  if (source) metadata.source = source;
  if (accountId) metadata.stripe_account_id = accountId;
  if (options.requiresSigning) metadata.requires_signing = true;
  const age = options.ageMinutes ?? 60;
  const studioAccount = options.studioHasAccount === false ? null : accountId;
  await sql(`
    insert into public.studios (id, name, slug, stripe_connected_account_id, stripe_connect_onboarding_complete, stripe_connect_charges_enabled, stripe_connect_payouts_enabled)
    values (${literal(studioId)}, 'CF1R1 Studio ${tag}', 'cf1r1-${tag}', ${literal(studioAccount)}, true, true, true);
    insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, account_required_for_registration)
    values (${literal(eventId)}, ${literal(studioId)}, 'CF1R1 Event ${tag}', 'cf1r1-e-${tag}', 'competition', current_date + 30, current_date + 30, 'published', 'public', true, false);
    insert into public.event_orders (id, event_id, studio_id, buyer_name, buyer_email, subtotal_amount, total_amount, currency, status, payment_status, stripe_checkout_session_id, expires_at, metadata)
    values (${literal(orderId)}, ${literal(eventId)}, ${literal(studioId)}, 'Buyer ${tag}', 'buyer-${tag}@example.test', ${totalCents / 100}, ${totalCents / 100}, ${literal(currency)},
            ${literal(status)}, ${literal(paymentStatus)}, ${literal(sessionId)}, ${status === "pending" ? "now() + interval '30 minutes'" : "null"}, ${literal(metadata)});
    insert into public.event_registrations (id, studio_id, event_id, order_id, status, payment_status, attendee_first_name, attendee_last_name, attendee_email, total_price, total_amount, stripe_checkout_session_id)
    values (${literal(registrationId)}, ${literal(studioId)}, ${literal(eventId)}, ${literal(orderId)}, ${literal(status === "confirmed" ? "confirmed" : status === "pending" ? "pending" : "cancelled")},
            ${literal(paymentStatus === "paid" ? "paid" : "pending")}, 'Pat', 'Dancer', 'buyer-${tag}@example.test', ${totalCents / 100}, ${totalCents / 100}, ${literal(sessionId)});
    set session_replication_role = replica;
    update public.event_orders set updated_at = now() - make_interval(mins => ${Math.trunc(age)}) where id = ${literal(orderId)};
  `);
  return { orderId, registrationId, studioId, eventId, sessionId, accountId, totalCents, currency };
}

export type OrderState = {
  status: string;
  payment_status: string;
  paid_at: string | null;
  stripe_payment_intent_id: string | null;
  expires_at: string | null;
  metadata: Record<string, unknown>;
  reg_status: string;
  reg_payment_status: string;
  payments: number;
};

export async function orderState(orderId: string): Promise<OrderState> {
  const [row] = await rows<OrderState>(`
    select o.status, o.payment_status, o.paid_at, o.stripe_payment_intent_id, o.expires_at, o.metadata,
           (select r.status from public.event_registrations r where r.order_id = o.id limit 1) as reg_status,
           (select r.payment_status from public.event_registrations r where r.order_id = o.id limit 1) as reg_payment_status,
           (select count(*)::int from public.event_payments p join public.event_registrations r on r.id = p.registration_id where r.order_id = o.id) as payments
    from public.event_orders o where o.id = '${orderId}'`);
  return row;
}

export type ClaimRow = { status: string; attempt_count: number; claim_owner: string | null; error: string | null; outcome: string | null };

export async function claimRow(eventId: string): Promise<ClaimRow | null> {
  const [row] = await rows<ClaimRow>(`select status, attempt_count, claim_owner, error_message as error, outcome from public.payment_provider_events where provider = 'stripe' and provider_event_id = '${eventId}'`);
  return row ?? null;
}
