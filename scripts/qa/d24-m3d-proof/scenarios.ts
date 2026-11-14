// Stripe-side scenarios S0-S10 of the proof (plan section 5), expressed as calls through the guarded client. The same sequence runs
// against the fake in --dry-run (this is what prints the planned call list) and against real Stripe TEST in a live run.
// Scenario S11 (cleanup) lives in cleanup.ts.
//
// IMPORTANT scope note: this revision drives the Stripe side only. The M3-B orchestrator + local Postgres ledger binding
// (intent state, registry row, audit events: S1/S4/S5/S6/S7 "ledger" assertions, V4 convergence in the ledger, V7 operator attach) is NOT
// wired here, so those parts are reported NOT TESTED rather than inferred. Nothing here claims to prove the ledger.

import { ProofAbort, type Expect } from "./types";
import { pinned, type GuardedClient } from "./guarded";

export type Check = { id: string; ok: boolean; detail: string };
export type ScenarioResult = { id: string; title: string; checks: Check[] };
export type VerdictValue = "PASS" | "FAIL" | "PASS (Stripe side only)" | "NOT TESTED";
export type Verdicts = Record<"V1" | "V2" | "V3" | "V4" | "V5" | "V6" | "V7", { verdict: VerdictValue; basis: string }>;

export type ScenarioDeps = {
  client: GuardedClient;
  expect: Expect;
  runId: string;
  sleep: (ms: number) => Promise<void>;
  /** S8 waits this long before replaying S1's key (plan: ~5 minutes). Dry-run passes 0. */
  replayWaitMs: number;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** A missing / malformed id (e.g. after an unexpected Stripe error) stops the run with a clear error and lets cleanup run, instead of building a nonsense path. */
function need(v: unknown, prefix: string, what: string): string {
  if (typeof v === "string" && v.startsWith(prefix)) return v;
  throw new ProofAbort("unexpected_error", `Stripe did not return a usable ${what}`);
}

export async function runScenarios(d: ScenarioDeps): Promise<{ results: ScenarioResult[]; verdicts: Verdicts }> {
  const { client, expect, runId } = d;
  const acct = expect.connectedAcct;
  const results: ScenarioResult[] = [];
  const scenario = (id: string, title: string) => {
    const r: ScenarioResult = { id, title, checks: [] };
    results.push(r);
    return { chk: (cid: string, ok: boolean, detail: string) => r.checks.push({ id: cid, ok, detail }) };
  };
  const key = (name: string) => `d24proof-${runId}-${name}`;
  const intent = (n: string) => `d24proof-intent-${runId}-${n}`;

  // synthetic, unique per run and per customer, on the reserved example.com (no mail service); drafts are never finalized or sent
  const alnum = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const email = (ref: string) => `d24-proof-${alnum(runId).slice(0, 16)}-${alnum(ref).slice(0, 16)}@example.com`;
  const createCustomer = (k: string, name: string, ref: string, expectStatus?: number[]) =>
    pinned(client, 
      { method: "POST", path: "/v1/customers", stripeAccount: acct, idempotencyKey: key(k), body: { name, email: email(ref), "metadata[d24_intent_id]": intent(ref), "metadata[d24_client_ref]": `proof-client-${ref}` } },
      { expectStatus },
    );
  const draftBody = (cus: string, ref: string, description = "D24-M3 proof invoice"): Record<string, string> => ({
    customer: cus,
    collection_method: "send_invoice",
    days_until_due: "14",
    currency: "usd",
    auto_advance: "false",
    description,
    "metadata[d24_intent_id]": intent(ref),
  });
  const createDraft = (k: string, cus: string, ref: string, expectStatus?: number[], description?: string) =>
    pinned(client, { method: "POST", path: "/v1/invoices", stripeAccount: acct, idempotencyKey: key(k), body: draftBody(cus, ref, description) }, { expectStatus });
  const listFor = (cus: string) => pinned(client, { method: "GET", path: "/v1/invoices", stripeAccount: acct, query: { customer: cus, limit: "100" } });
  const dataIds = (r: { json: Record<string, unknown> | null }) => (Array.isArray(r.json?.data) ? (r.json?.data as Array<Record<string, unknown>>).map((x) => str(x.id)) : []);

  // ---- S1: draft creation (customer + invoice + lines) --------------------------------------------------------------------------
  const s1 = scenario("S1", "Draft creation: customer, invoice, lines");
  const cus1 = await createCustomer("cus-1", "D24-M3 proof client 1", "A");
  const cus1Id = need(cus1.json?.id, "cus_", "customer id");
  s1.chk("customer", cus1Id.startsWith("cus_") && cus1.json?.livemode === false, "customer created in the connected account, livemode false");
  const invA = await createDraft("inv-A", cus1Id, "A");
  const invAId = need(invA.json?.id, "in_", "invoice id");
  const lineBody = { "lines[0][description]": "Proof line 1", "lines[0][amount]": "5500", "lines[1][description]": "Proof line 2", "lines[1][amount]": "2500" };
  const linesA = await pinned(client, { method: "POST", path: `/v1/invoices/${invAId}/add_lines`, stripeAccount: acct, idempotencyKey: key("inv-A:lines"), body: lineBody });
  s1.chk("shape", invAId.startsWith("in_") && invA.json?.livemode === false && invA.json?.status === "draft" && invA.json?.customer === cus1Id && invA.json?.currency === "usd", "V1: response carries id, livemode=false, status=draft, customer, currency");
  s1.chk("send_invoice", invA.json?.collection_method === "send_invoice" && invA.json?.auto_advance === false, "collection_method=send_invoice, auto_advance=false");
  s1.chk("total", linesA.json?.total === 8000 && linesA.json?.status === "draft", "V3: total == sum(lines) (8000) and still draft");

  // ---- S2: duplicate create (listing shows one invoice) -------------------------------------------------------------------------
  const s2 = scenario("S2", "Duplicate create: one invoice for the customer");
  const l2 = await listFor(cus1Id);
  s2.chk("one", dataIds(l2).length === 1 && dataIds(l2)[0] === invAId, "the customer has exactly one invoice (the S1 draft)");

  // ---- S3: idempotency at Stripe ------------------------------------------------------------------------------------------------
  const s3 = scenario("S3", "Idempotency at Stripe: replay and changed parameters");
  const replay = await createDraft("inv-A", cus1Id, "A");
  s3.chk("replay", str(replay.json?.id) === invAId && replay.replayed === true, "V2: same key + same params returns the same invoice with Idempotent-Replayed: true");
  const conflict = await createDraft("inv-A", cus1Id, "A", [400, 409], "D24-M3 proof invoice CHANGED");
  s3.chk("conflict", conflict.status >= 400 && str((conflict.json?.error as Record<string, unknown> | undefined)?.type) === "idempotency_error", "V2: same key + different params is an idempotency error (the orchestrator sends this to needs_review)");
  const custReplay = await createCustomer("cus-1", "D24-M3 proof client 1", "A");
  s3.chk("customer_replay", str(custReplay.json?.id) === cus1Id, "V3: ensureCustomer replay returns the same customer");

  // ---- S4: concurrent retries ---------------------------------------------------------------------------------------------------
  const s4 = scenario("S4", "Concurrent retries, same key");
  // allSettled: wait for EVERY parallel call to finish before anything else (cleanup included) can start, then surface the first failure
  const settled = await Promise.allSettled([0, 1, 2].map(() => createDraft("inv-B", cus1Id, "B", [200, 409])).map((p) => p));
  const firstRejected = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (firstRejected) throw firstRejected.reason;
  const par = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof createDraft>>>).value);
  const okIds = new Set(par.filter((r) => r.status === 200).map((r) => str(r.json?.id)));
  s4.chk("one_id", okIds.size === 1 && par.every((r) => r.status === 200 || r.status === 409), "all successful responses carry one invoice id (others are in-flight conflicts)");
  const l4 = await listFor(cus1Id);
  s4.chk("two_total", dataIds(l4).length === 2, "the customer has exactly two invoices after three parallel creates of B (A and B)");

  // ---- S5: crash after success --------------------------------------------------------------------------------------------------
  const s5 = scenario("S5", "Crash after success: response discarded, fresh replay converges");
  const cus2 = await createCustomer("cus-2", "D24-M3 proof client 2", "C");
  const cus2Id = need(cus2.json?.id, "cus_", "customer id");
  const lost = await createDraft("inv-C", cus2Id, "C"); // the response is intentionally NOT used for control flow: the process 'crashed'
  const converged = await createDraft("inv-C", cus2Id, "C");
  s5.chk("converged", str(converged.json?.id) === str(lost.json?.id) && converged.replayed === true, "V4 (Stripe side): the replayed original key returns the invoice created before the 'crash'");
  const l5 = await listFor(cus2Id);
  s5.chk("one", dataIds(l5).length === 1, "Stripe shows one invoice for the customer");

  // ---- S6: unknown outcome ------------------------------------------------------------------------------------------------------
  const s6 = scenario("S6", "Unknown outcome: connection error after a real create");
  const lost6 = await createDraft("inv-D", cus2Id, "D");
  const again6 = await createDraft("inv-D", cus2Id, "D");
  s6.chk("converged", str(again6.json?.id) === str(lost6.json?.id) && again6.replayed === true, "the single recovery replay converges on the same invoice");
  const l6 = await listFor(cus2Id);
  s6.chk("two", dataIds(l6).length === 2, "Stripe shows exactly two invoices for the second customer (C and D)");

  // ---- S7: needs_review evidence read -------------------------------------------------------------------------------------------
  const s7 = scenario("S7", "needs_review: find the draft by metadata from one read");
  const l7 = await listFor(cus1Id);
  const hit = (Array.isArray(l7.json?.data) ? (l7.json?.data as Array<Record<string, unknown>>) : []).filter(
    (x) => (x.metadata as Record<string, unknown> | undefined)?.d24_intent_id === intent("A"),
  );
  s7.chk("found", hit.length === 1 && str(hit[0].id) === invAId, "V7 (Stripe side): one read finds exactly one draft with the intent's metadata, and no POST /v1/invoices was issued in this step");

  // ---- S8: idempotency retention, bounded ---------------------------------------------------------------------------------------
  const s8 = scenario("S8", "Idempotency retention, bounded (no pruning attempted)");
  if (d.replayWaitMs > 0) await d.sleep(d.replayWaitMs);
  const late = await createDraft("inv-A", cus1Id, "A");
  s8.chk("replayed_later", str(late.json?.id) === invAId && late.replayed === true, `replay after ~${Math.round(d.replayWaitMs / 60000)} min still returns the original invoice (documented retention + URL are recorded by the operator, not by this script)`);

  // ---- S9: inertness ------------------------------------------------------------------------------------------------------------
  const s9 = scenario("S9", "Inertness: drafts only, nothing sent");
  let allDraft = true;
  for (const id of [...client.seen.drafts]) {
    const r = await pinned(client, { method: "GET", path: `/v1/invoices/${id}`, stripeAccount: acct });
    if (r.json?.status !== "draft" || r.json?.auto_advance !== false || r.json?.collection_method !== "send_invoice" || r.json?.livemode !== false) allDraft = false;
  }
  s9.chk("all_drafts", allDraft && client.seen.nonDrafts.size === 0, "V5: every created invoice is a draft, auto_advance=false, send_invoice, livemode=false (dashboard Events review is manual)");

  // ---- S10: permission negatives ------------------------------------------------------------------------------------------------
  const s10 = scenario("S10", "Permission negatives (expected 403)");
  const n1 = await pinned(client, { method: "GET", path: "/v1/transfers", stripeAccount: acct, query: { limit: "1" } }, { expectStatus: [403] });
  const n2 = await pinned(client, { method: "GET", path: "/v1/webhook_endpoints", stripeAccount: acct }, { expectStatus: [403] });
  s10.chk("transfers", n1.status === 403, "V6: Transfers read is refused by the key");
  s10.chk("webhooks", n2.status === 403, "V6: Webhook Endpoints read is refused by the key");

  const ok = (s: ScenarioResult) => s.checks.length > 0 && s.checks.every((c) => c.ok);
  const by = (id: string) => results.find((r) => r.id === id) as ScenarioResult;
  const v = (pass: boolean, basis: string, partial = false): { verdict: VerdictValue; basis: string } => ({ verdict: pass ? (partial ? "PASS (Stripe side only)" : "PASS") : "FAIL", basis });
  const verdicts: Verdicts = {
    V1: v(by("S1").checks.filter((c) => ["shape", "send_invoice"].includes(c.id)).every((c) => c.ok), "S1 response shape"),
    V2: v(by("S3").checks.filter((c) => c.id !== "customer_replay").every((c) => c.ok), "S3 replay + changed parameters"),
    V3: v(by("S1").checks.find((c) => c.id === "total")!.ok && by("S3").checks.find((c) => c.id === "customer_replay")!.ok, "S1 total, S3 customer replay"),
    V4: v(ok(by("S5")) && ok(by("S6")), "S5/S6 replay converges; the local ledger part is NOT wired in this revision", true),
    V5: v(ok(by("S9")), "S9 retrieval of every invoice"),
    V6: v(ok(by("S10")), "S10 two 403s (other operations are barred by the allow-list wrapper, not by Stripe)"),
    V7: v(ok(by("S7")), "S7 one read finds the draft; the operator attach (platform-admin AAL2) is NOT wired in this revision", true),
  };
  return { results, verdicts };
}

export function assertNoAbort(client: GuardedClient): void {
  const a = client.aborted();
  if (a) throw a;
}
export { ProofAbort };
