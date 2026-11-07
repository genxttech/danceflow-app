import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CONSISTENT_UNVERIFIED, EXIT_DISCREPANCIES, EXIT_INPUT, main as cliMain } from "../reconcile-cli";
import { idempotencyMatches, parseProofTranscript, parseProviderLog, reconcile, type Provenance, type ProviderEntry, type SentRequest } from "../reconcile";

const T0 = Date.parse("2026-11-08T10:00:00Z");
// the window is supplied independently of the transcript: 09:58 .. 10:05
const W = { fromUtc: "2026-11-08T09:58:00Z", toUtc: "2026-11-08T10:05:00Z" };
const O = { window: W };
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const prov: Provenance = { source: "workbench_logs", obtainedBy: "engineer", obtainedAtUtc: at(900), filterDescription: "2026-11-08 09:50-10:20Z, all methods, all statuses, platform key + connected", coversWholeWindowAllMethodsAllStatuses: true };
const sent = (n: number, s: number, o: Partial<SentRequest> = {}): SentRequest => ({ n, atUtc: at(s), method: "GET", path: "/v1/account", status: 200, requestId: `req_s${n}`, ...o });
const pe = (n: number, s: number, o: Partial<ProviderEntry> = {}): ProviderEntry => ({ requestId: `req_s${n}`, method: "GET", path: "/v1/account", status: 200, createdUtc: at(s), ...o });
const kinds = (r: ReturnType<typeof reconcile>) => r.findings.filter((f) => f.severity !== "info").map((f) => f.kind);

describe("reconcile", () => {
  it("matching logs are CONSISTENT but independent verification is still required", () => {
    const r = reconcile(
      [sent(1, 0), sent(2, 5, { method: "POST", path: "/v1/customers", idempotencyKey: "abcdefghijkl…(30)", stripeAccount: "acct_abc…yz" })],
      [pe(1, 1), pe(2, 6, { method: "POST", path: "/v1/customers", idempotencyKey: "abcdefghijkl" + "x".repeat(18), account: "acct_abcdef12345yz" })],
      prov,
      O,
    );
    expect(r.verdict).toBe("CONSISTENT");
    expect(r.independentVerification).toBe("STILL_REQUIRED");
    expect(r.counts).toMatchObject({ sentNetwork: 2, matched: 2 });
  });
  it("detects a request the app sent that the provider lacks", () => {
    const r = reconcile([sent(1, 0), sent(2, 5)], [pe(1, 1)], prov, O);
    expect(r.verdict).toBe("DISCREPANCIES");
    expect(r.findings.find((f) => f.kind === "missing_in_provider")).toMatchObject({ requestId: "req_s2" });
    expect(kinds(r)).toContain("count_mismatch");
  });
  it("detects an unexpected extra operation at the provider (in window)", () => {
    const r = reconcile([sent(1, 0)], [pe(1, 1), pe(9, 3, { method: "DELETE", path: "/v1/accounts/acct_x", requestId: "req_extra" })], prov, O);
    expect(r.findings.find((f) => f.kind === "extra_in_provider")).toMatchObject({ requestId: "req_extra" });
    expect(r.verdict).toBe("DISCREPANCIES");
  });
  it("a provider entry outside the independent window FAILS (not ignored)", () => {
    const r = reconcile([sent(1, 0)], [pe(1, 1), pe(7, 3600, { requestId: "req_old" })], prov, O);
    expect(r.verdict).toBe("DISCREPANCIES");
    expect(r.findings.some((f) => f.kind === "out_of_window_provider" && f.severity === "fail" && f.requestId === "req_old")).toBe(true);
  });
  it("a truncated transcript cannot hide extras: the window is NOT derived from the transcript", () => {
    const r = reconcile([sent(1, 0)], [pe(1, 1), pe(9, 240, { requestId: "req_late", method: "DELETE", path: "/v1/customers/cus_1" })], prov, O);
    expect(r.verdict).toBe("DISCREPANCIES");
    expect(r.findings.some((f) => f.kind === "extra_in_provider" && f.requestId === "req_late")).toBe(true);
  });
  it("a missing or invalid independent window is unusable, never CONSISTENT", () => {
    expect(reconcile([sent(1, 0)], [pe(1, 1)], prov, { window: { fromUtc: "x", toUtc: "y" } }).verdict).toBe("DISCREPANCIES");
    expect(reconcile([sent(1, 0)], [pe(1, 1)], prov, { window: { fromUtc: W.toUtc, toUtc: W.fromUtc } }).verdict).toBe("DISCREPANCIES");
    expect(reconcile([sent(1, 0)], [pe(1, 1)], prov, undefined as never).verdict).toBe("DISCREPANCIES");
  });
  it("a transcript entry outside the operator's window fails", () => {
    expect(reconcile([sent(1, 0), sent(2, 3600)], [pe(1, 1), pe(2, 3601)], prov, O).findings.some((f) => f.kind === "out_of_window_sent")).toBe(true);
  });
  it("flags duplicate request ids on either side", () => {
    const r = reconcile([sent(1, 0), sent(2, 2, { requestId: "req_s1" })], [pe(1, 1), pe(1, 1)], prov, O);
    expect(kinds(r)).toEqual(expect.arrayContaining(["duplicate_in_provider", "duplicate_in_sent"]));
    expect(r.verdict).toBe("DISCREPANCIES");
  });
  it("an idempotent replay matched to the original is informational and not double counted", () => {
    const key = "d24prov-abcd…(30)";
    const s1 = sent(1, 0, { method: "POST", path: "/v1/accounts", idempotencyKey: key });
    const s2 = sent(2, 4, { method: "POST", path: "/v1/accounts", idempotencyKey: key, requestId: "req_replay", replayed: true });
    const r = reconcile([s1, s2], [pe(1, 1, { method: "POST", path: "/v1/accounts", idempotencyKey: "d24prov-abcdef" + "z".repeat(16) })], prov, O);
    expect(r.findings.some((f) => f.kind === "replay_matched_to_original")).toBe(true);
    expect(r.verdict).toBe("CONSISTENT");
  });
  it("a replay line cannot launder an extra provider request", () => {
    const key = "d24prov-abcd…(30)";
    const r = reconcile([sent(1, 0), sent(2, 4, { method: "POST", path: "/v1/accounts", idempotencyKey: key, requestId: "req_replay", replayed: true })], [pe(1, 1), pe(5, 3, { requestId: "req_x", method: "POST", path: "/v1/accounts", idempotencyKey: "d24prov-abcdef" + "z".repeat(16) })], prov, O);
    expect(r.verdict).toBe("DISCREPANCIES");
    expect(r.findings.some((f) => f.kind === "replay_without_original")).toBe(true);
    expect(r.findings.some((f) => f.kind === "extra_in_provider" && f.requestId === "req_x")).toBe(true);
  });
  it("a replay with a different key than the matched original is not explained", () => {
    const orig = sent(1, 0, { method: "POST", path: "/v1/accounts", idempotencyKey: "d24prov-aaaa…(30)" });
    const other = sent(2, 4, { method: "POST", path: "/v1/accounts", idempotencyKey: "d24prov-bbbb…(30)", requestId: "req_replay", replayed: true });
    const r = reconcile([orig, other], [pe(1, 1, { method: "POST", path: "/v1/accounts", idempotencyKey: "d24prov-aaaa" + "z".repeat(18) })], prov, O);
    expect(r.findings.some((f) => f.kind === "replay_without_original")).toBe(true);
    expect(r.verdict).toBe("DISCREPANCIES");
  });
  it("transcript lines that fail to parse produce a finding and a non-consistent result", () => {
    const parsed = parseProofTranscript(" 1. 2026-11-08T10:00:00.000Z GET /v1/account acct=- idem=- -> 200 req=req_s1 {}\n 2. garbled line that is numbered\nCalls used: 2");
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.unparsed).toHaveLength(1);
    const r = reconcile(parsed.requests, [pe(1, 0)], prov, { ...O, unparsedTranscriptLines: parsed.unparsed });
    expect(r.verdict).toBe("DISCREPANCIES");
    expect(r.findings.some((f) => f.kind === "transcript_unparsed")).toBe(true);
  });
  it("a garbled numbered line is flagged even with no Calls-used footer", () => {
    const p = parseProofTranscript(" 1. 2026-11-08T10:00:00.000Z GET /v1/account acct=- idem=- -> 200 req=req_s1 {}\n 2. 2026-11-08T10:00:01Z GET /v1/x ?? nonsense");
    expect(p.requests).toHaveLength(1);
    expect(p.unparsed).toEqual([expect.stringContaining("nonsense")]);
  });
  it("a declared call count that disagrees with the parsed lines is reported", () => {
    const p = parseProofTranscript(" 1. 2026-11-08T10:00:00.000Z GET /v1/account acct=- idem=- -> 200 req=req_s1 {}\nCalls used: 3");
    expect(p.unparsed.join()).toMatch(/Calls used: 3/);
  });
  it("failed 4xx requests match on status; a status disagreement fails", () => {
    const ok = reconcile([sent(1, 0, { status: 403, path: "/v1/balance" })], [pe(1, 1, { status: 403, path: "/v1/balance" })], prov, O);
    expect(ok.verdict).toBe("CONSISTENT");
    const bad = reconcile([sent(1, 0, { status: 403, path: "/v1/balance" })], [pe(1, 1, { status: 200, path: "/v1/balance" })], prov, O);
    expect(bad.findings.find((f) => f.kind === "field_mismatch")?.detail).toMatch(/status/);
  });
  it("detects method/path/account/idempotency/time mismatches on a matched id", () => {
    const r = reconcile(
      [sent(1, 0, { method: "POST", path: "/v1/customers", idempotencyKey: "aaaaaaaaaaaa…(20)", stripeAccount: "acct_abc…yz" })],
      [pe(1, 400, { method: "GET", path: "/v1/invoices", idempotencyKey: "bbbbbbbbbbbb", account: null })],
      prov,
      { window: { fromUtc: "2026-11-08T09:00:00Z", toUtc: "2026-11-08T11:00:00Z" } },
    );
    const details = r.findings.filter((f) => f.kind === "field_mismatch").map((f) => f.detail).join("|");
    expect(details).toMatch(/method/);
    expect(details).toMatch(/path/);
    expect(details).toMatch(/Stripe-Account/);
    expect(details).toMatch(/idempotency/);
    expect(kinds(r)).toContain("time_skew");
  });
  it("an app entry with no response is matched to the provider when it did reach Stripe", () => {
    const e = sent(1, 0, { status: "ERROR", requestId: undefined, method: "POST", path: "/v1/customers", idempotencyKey: "abcdefghijkl…(20)" });
    const reached = reconcile([e], [pe(1, 1, { requestId: "req_late", method: "POST", path: "/v1/customers", idempotencyKey: "abcdefghijkl" + "q".repeat(8) })], prov, O);
    expect(reached.findings.some((f) => f.kind === "error_entry_matched")).toBe(true);
    expect(reached.verdict).toBe("CONSISTENT");
    const lost = reconcile([sent(0, 0), e], [pe(0, 0)], prov, O);
    expect(lost.findings.some((f) => f.kind === "error_entry_not_in_provider")).toBe(true);
  });
  it("BLOCKED requests must not appear at the provider", () => {
    const b = sent(2, 3, { status: "BLOCKED", requestId: undefined, method: "POST", path: "/v1/invoices/in_1/finalize" });
    expect(reconcile([sent(1, 0), b], [pe(1, 1)], prov, O).verdict).toBe("CONSISTENT");
    const r = reconcile([sent(1, 0), b], [pe(1, 1), pe(5, 3, { requestId: "req_fin", method: "POST", path: "/v1/invoices/in_1/finalize" })], prov, O);
    expect(r.verdict).toBe("DISCREPANCIES");
  });
  it("missing or weak provenance fails; a partial events-only source warns", () => {
    expect(reconcile([sent(1, 0)], [pe(1, 1)], null, O).verdict).toBe("DISCREPANCIES");
    expect(reconcile([sent(1, 0)], [pe(1, 1)], { ...prov, coversWholeWindowAllMethodsAllStatuses: false }, O).verdict).toBe("DISCREPANCIES");
    const w = reconcile([sent(1, 0)], [pe(1, 1)], { ...prov, source: "events_api_partial" }, O);
    expect(w.verdict).toBe("CONSISTENT");
    expect(w.findings.some((f) => f.severity === "warn" && f.kind === "provenance_problem")).toBe(true);
  });
  it("empty app transcript is unusable, not CONSISTENT", () => {
    expect(reconcile([], [pe(1, 1)], prov, O).verdict).toBe("DISCREPANCIES");
  });
});

describe("idempotencyMatches", () => {
  it("handles masked, full and absent keys", () => {
    expect(idempotencyMatches("abcdefghijkl…(5)", "abcdefghijkl")).toBe(false);
    expect(idempotencyMatches("abc…(3)", "abc")).toBe(true);
    expect(idempotencyMatches("same", "same")).toBe(true);
    expect(idempotencyMatches("-", undefined)).toBe(true);
    expect(idempotencyMatches("x", undefined)).toBe(false);
  });
});

describe("parsers", () => {
  it("parses the proof transcript line format", () => {
    const text = ` 1. 2026-11-08T10:00:00.000Z GET /v1/account acct=- idem=- -> 200 req=req_a {"id":"acct_x"}\n 2. 2026-11-08T10:00:01.000Z POST /v1/customers acct=acct_abc…yz idem=abcdefghijkl…(30) -> 200 req=req_b replayed {}\n 3. 2026-11-08T10:00:02.000Z POST /v1/invoices/in_1/finalize acct=acct_abc…yz idem=- -> BLOCKED req=- {}\nCalls used: 3`;
    const p = parseProofTranscript(text).requests;
    expect(p).toHaveLength(3);
    expect(p[1]).toMatchObject({ method: "POST", requestId: "req_b", replayed: true, stripeAccount: "acct_abc…yz", status: 200 });
    expect(p[2]).toMatchObject({ status: "BLOCKED", requestId: undefined });
  });
  it("parses the provider wrapper with aliases and reports bad entries", () => {
    const r = parseProviderLog({
      provenance: { source: "dashboard_logs", obtainedBy: "e", obtainedAtUtc: "2026-11-08T11:00:00Z", filterDescription: "f", coversWholeWindowAllMethodsAllStatuses: true },
      entries: [{ id: "req_1", http_method: "get", endpoint: "/v1/account", status_code: 200, created: 1794218400, stripe_account: "acct_1" }, { id: "bad" }],
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ method: "GET", account: "acct_1" });
    expect(r.problems).toHaveLength(1);
    expect(parseProviderLog([]).problems).toHaveLength(1);
    expect(parseProviderLog({ provenance: { source: "app_collected" }, entries: [] }).problems.join()).toMatch(/not an independent source/);
  });
});

describe("reconcile-cli exit codes", () => {
  const dir = mkdtempSync(join(tmpdir(), "d24rec-"));
  const tx = join(dir, "t.txt");
  const pv = join(dir, "p.json");
  writeFileSync(tx, " 1. 2026-11-08T10:00:00.000Z GET /v1/account acct=- idem=- -> 200 req=req_a {}\nCalls used: 1");
  const wrap = (entries: unknown[]) => JSON.stringify({ provenance: prov, entries });
  const entry = { requestId: "req_a", method: "GET", path: "/v1/account", status: 200, createdUtc: "2026-11-08T10:00:01Z" };
  const win = ["--window-start", W.fromUtc, "--window-end", W.toUtc];
  const run = (extra: string[]) => { const out: string[] = []; const code = cliMain(["--transcript", tx, "--provider", pv, ...extra], (s) => out.push(s)); return { code, text: out.join("\n") }; };
  it("consistent is never exit 0 and still says it is not independent verification", () => {
    writeFileSync(pv, wrap([entry]));
    const r = run(win);
    expect(r.code).toBe(EXIT_CONSISTENT_UNVERIFIED);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/CONSISTENT_UNVERIFIED/);
    expect(r.text).toMatch(/NOT independent verification/);
  });
  it("discrepancies and input problems use their own codes; the window is required", () => {
    writeFileSync(pv, wrap([entry, { ...entry, requestId: "req_extra", createdUtc: "2026-11-08T10:01:00Z" }]));
    expect(run(win).code).toBe(EXIT_DISCREPANCIES);
    expect(run([]).code).toBe(EXIT_INPUT);
    expect(run(["--window-start", W.toUtc, "--window-end", W.fromUtc]).code).toBe(EXIT_INPUT);
    rmSync(dir, { recursive: true, force: true });
  });
});
