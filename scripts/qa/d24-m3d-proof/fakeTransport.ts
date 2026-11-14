// OFFLINE fake Stripe for the proof's dry-run and unit tests. It models exactly the behaviours the proof cares about
// (idempotent replay, same-key/different-params error, draft invoices with add_lines totals, listing, drafts-only delete, 403 on
// unpermitted reads). It performs no I/O and holds no secrets. Passing against it proves nothing about real Stripe; that is the point of the proof.

import { STRIPE_API_VERSION } from "./config";
import type { ProofRequest, ProofResponse, Transport } from "./types";

export type FakeOptions = {
  platformId: string;
  connectedId: string;
  /** Test knobs: make the fake misbehave so the guards can be exercised. */
  livemodeOnInvoices?: boolean;
  invoiceStatusAfterCreate?: string;
  failWith?: { status: number; times: number };
  accountType?: string;
  /** the connected account's `controller` field (omitted from the answer when the key is absent; null / odd values pass through as given) */
  accountController?: unknown;
  /** livemode on the connected-account answer */
  accountLivemode?: boolean;
  platformIdOverride?: string;
  /** the Stripe-Version the fake claims to have used in its responses (default: the pin) */
  reportVersion?: string;
};

type Obj = Record<string, unknown> & { id: string; object: string };

export function createFakeTransport(o: FakeOptions): { transport: Transport; calls: ProofRequest[]; state: { invoices: Map<string, Obj>; customers: Map<string, Obj> } } {
  const invoices = new Map<string, Obj>();
  const customers = new Map<string, Obj>();
  const idem = new Map<string, { sig: string; res: Obj }>();
  const calls: ProofRequest[] = [];
  let seq = 0;
  let failTimes = o.failWith?.times ?? 0;
  const id = (p: string) => `${p}_FAKE${String(++seq).padStart(6, "0")}`;
  const ver = () => o.reportVersion ?? STRIPE_API_VERSION;
  const ok = (json: Obj | Record<string, unknown>, replayed = false): ProofResponse => ({ status: 200, requestId: `req_fake${seq}`, replayed, stripeVersion: ver(), json });
  const err = (status: number, type: string, code?: string): ProofResponse => ({ status, requestId: `req_fake${seq}`, stripeVersion: ver(), json: { error: { type, code } } });

  const transport: Transport = async (req) => {
    calls.push(structuredClone(req));
    if (failTimes > 0 && o.failWith) {
      failTimes -= 1;
      return err(o.failWith.status, "api_error");
    }
    const { method, path } = req;
    if (method === "GET" && path === "/v1/account") return ok({ id: o.platformIdOverride ?? o.platformId, object: "account", livemode: false });
    if (method === "GET" && path === `/v1/accounts/${o.connectedId}`) return ok({ id: o.connectedId, object: "account", type: o.accountType ?? "express", ...("accountController" in o ? { controller: o.accountController } : {}), ...(o.accountLivemode !== undefined ? { livemode: o.accountLivemode } : {}) });
    if (req.stripeAccount !== o.connectedId) return err(400, "invalid_request_error", "account_invalid");
    if (method === "GET" && (path === "/v1/transfers" || path === "/v1/webhook_endpoints")) return err(403, "invalid_request_error", "permission");

    if (method === "POST" && (path === "/v1/customers" || path === "/v1/invoices" || /^\/v1\/invoices\/[^/]+\/add_lines$/.test(path))) {
      const key = `${req.stripeAccount}|${req.idempotencyKey}`;
      const sig = `${method} ${path} ${JSON.stringify(Object.entries(req.body ?? {}).sort())}`;
      const prior = idem.get(key);
      if (prior) {
        if (prior.sig !== sig) return err(400, "idempotency_error");
        return ok(prior.res, true);
      }
      let res: Obj;
      if (path === "/v1/customers") {
        res = { id: id("cus"), object: "customer", livemode: false, name: req.body?.name ?? null, email: req.body?.email ?? null };
        customers.set(res.id, res);
      } else if (path === "/v1/invoices") {
        if (!customers.has(String(req.body?.customer))) return err(400, "invalid_request_error", "resource_missing");
        // what Stripe really does (proof run 3, req_TtLV74WY5HVm4g): a send_invoice invoice needs a customer with a valid email
        if (req.body?.collection_method === "send_invoice" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(customers.get(String(req.body?.customer))?.email ?? ""))) return err(400, "invalid_request_error", "email_invalid");
        res = {
          id: id("in"),
          object: "invoice",
          livemode: o.livemodeOnInvoices ?? false,
          status: o.invoiceStatusAfterCreate ?? "draft",
          customer: req.body?.customer,
          collection_method: req.body?.collection_method,
          auto_advance: req.body?.auto_advance === "true",
          total: 0,
          currency: req.body?.currency,
          metadata: { d24_intent_id: req.body?.["metadata[d24_intent_id]"] ?? null },
        };
        invoices.set(res.id, res);
      } else {
        const invId = path.split("/")[3];
        const inv = invoices.get(invId);
        if (!inv) return err(404, "invalid_request_error", "resource_missing");
        let add = 0;
        for (const [k, v] of Object.entries(req.body ?? {})) if (/\]\[amount\]$/.test(k)) add += Number(v);
        inv.total = Number(inv.total) + add;
        res = inv;
      }
      idem.set(key, { sig, res });
      return ok(res);
    }
    if (method === "GET" && path === "/v1/invoices") {
      const cus = req.query?.customer;
      const data = [...invoices.values()].filter((i) => i.customer === cus);
      return ok({ object: "list", data } as unknown as Obj);
    }
    const inv = /^\/v1\/invoices\/(in_[A-Za-z0-9]+)$/.exec(path);
    if (inv && method === "GET") {
      const v = invoices.get(inv[1]);
      return v ? ok(v) : err(404, "invalid_request_error", "resource_missing");
    }
    if (inv && method === "DELETE") {
      const v = invoices.get(inv[1]);
      if (!v) return err(404, "invalid_request_error", "resource_missing");
      if (v.status !== "draft") return err(400, "invalid_request_error", "invoice_not_editable");
      invoices.delete(inv[1]);
      return ok({ id: inv[1], object: "invoice", deleted: true });
    }
    const cus = /^\/v1\/customers\/(cus_[A-Za-z0-9]+)$/.exec(path);
    if (cus && method === "DELETE") {
      if (!customers.delete(cus[1])) return err(404, "invalid_request_error", "resource_missing");
      return ok({ id: cus[1], object: "customer", deleted: true });
    }
    return err(404, "invalid_request_error", "unrecognized_request_url");
  };
  return { transport, calls, state: { invoices, customers } };
}
