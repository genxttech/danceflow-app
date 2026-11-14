import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RedactedSecret } from "../twilioIsv/account";
import { mapTwilioStatusToSmsLogStatus, smsLogStatusesReplaceableBy } from "../twilio";
import { RealBilledSmsProvider, type BilledMessageEvidence, type InboundMessageEvidence } from "../usageProvider";
import { classifyRecoveredBody, laterKeywordFor } from "../usageReconciler";

vi.mock("server-only", () => ({}));

/**
 * TW-4F activation evidence: the provider adapter, the inbound recovery and the status table checked against Twilio's DOCUMENTED Message resource,
 * list page and webhook shapes (fixtures/twilio/documentedShapes.json: full field sets, extra fields, nulls and paging exactly as documented; every
 * identifier synthetic). When real captured samples exist (fixtures/twilio/capturedShapes.json, same keys, redacted per
 * docs/twilio/TW-4F_Twilio_Fixture_Capture.md) every case runs against them too. Documented shapes are NOT a substitute for one captured sample.
 */

type Shapes = {
  _provenance: { kind: string };
  account: string;
  service: string;
  sender: string;
  texter: string;
  messages: Record<string, Record<string, unknown>>;
  list_inbound: { page0: Record<string, unknown> & { next_page_uri: string; messages: Record<string, unknown>[] }; page1: Record<string, unknown> & { messages: Record<string, unknown>[] } };
  webhooks: Record<string, Record<string, string>>;
  documented_statuses: string[];
  documented_directions: string[];
};

const dir = path.join(process.cwd(), "src/lib/sms/__tests__/fixtures/twilio");
const load = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Shapes;
const sources: Array<[string, Shapes]> = [["documented", load("documentedShapes.json")]];
if (existsSync(path.join(dir, "capturedShapes.json"))) sources.push(["captured", load("capturedShapes.json")]);
const documented = sources[0][1];

const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;
const tokens = { tokenFor: async () => new RedactedSecret("t0ken".repeat(6) + "ab"), refresh: async () => ({ secret: new RedactedSecret("x"), changed: false }) };

function provider(reply: (url: string) => unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const body = reply(url);
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
  return { real: new RealBilledSmsProvider(tokens, { fetchImpl, allowRead: true }), urls };
}

describe("documented fixtures are synthetic and well formed", () => {
  it("are labelled as documented shapes and use only fiction numbers and well-formed SIDs", () => {
    expect(documented._provenance.kind).toBe("DOCUMENTED SHAPE, NOT CAPTURED TRAFFIC");
    const text = readFileSync(path.join(dir, "documentedShapes.json"), "utf8");
    for (const phone of text.match(/\+1[0-9]{10}/g) ?? []) expect(phone).toMatch(/^\+1555010[0-9]{4}$/);
    for (const sid of text.match(/\b(SM|MM|AC|MG)[0-9a-zA-Z]{32}\b/g) ?? []) expect(sid).toMatch(/^(SM|MM|AC|MG)[0-9a-f]{32}$/);
    expect(text).not.toMatch(/auth_?token|password|secret/i);
  });
});

describe.each(sources)("Message resource (%s shapes) through the real adapter", (_name, shapes) => {
  const fetchAs = async (key: string) => {
    const json = shapes.messages[key];
    const { real } = provider(() => json);
    return { json, evidence: await real.fetchMessage(shapes.account, String(json.sid)) };
  };
  const evidenceKeys: Array<keyof BilledMessageEvidence> = [
    "sid", "account_sid", "status", "num_segments", "num_media", "price", "price_unit", "direction", "messaging_service_sid", "from", "to", "date_created", "date_sent", "error_code",
  ];

  it.each(Object.keys(shapes.messages))("%s: identity, ISO times and strings only; the body and every other field are dropped", async (key) => {
    const { json, evidence } = await fetchAs(key);
    expect(Object.keys(evidence).sort()).toEqual([...evidenceKeys].sort());
    expect(evidence).toMatchObject({ sid: json.sid, account_sid: json.account_sid, status: json.status, direction: json.direction, to: json.to, from: json.from ?? null });
    for (const k of ["date_created", "date_sent"] as const) {
      if (json[k] === null) expect(evidence[k]).toBeNull();
      else expect(evidence[k]).toBe(new Date(Date.parse(String(json[k]))).toISOString());
    }
    // the database's own parsers (settle): ISO instant, segment / media text, a signed decimal price
    expect(evidence.date_created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    if (evidence.num_segments !== null) expect(evidence.num_segments).toMatch(/^[0-9]{1,3}$/);
    if (evidence.price !== null) expect(evidence.price).toMatch(/^-?[0-9]{1,6}(\.[0-9]{1,10})?$/);
    expect(JSON.stringify(evidence)).not.toContain(String(json.body));
  });

  it.runIf(_name === "documented")("an integer error_code (as documented) becomes its text; a Messaging Service send has no sender until Twilio picks one", async () => {
    expect((await fetchAs("fetch_undelivered_30007")).evidence.error_code).toBe("30007");
    const accepted = (await fetchAs("create_accepted")).evidence;
    expect(accepted).toMatchObject({ status: "accepted", from: null, date_sent: null, price: null, num_segments: "0" });
    expect((await fetchAs("fetch_sent_price_pending")).evidence).toMatchObject({ status: "sent", price: null, price_unit: "USD" });
  });
});

describe.each(sources.filter(([, s]) => s.list_inbound?.page0))("Message list (%s shapes): any captured page through the real adapter", (_name, shapes) => {
  it("pages through Twilio's own next_page_uri, keeps only inbound messages with well-formed SIDs and ISO times", async () => {
    const { page0, page1 } = shapes.list_inbound;
    const { real, urls } = provider(() => (urls.length > 1 && page1 ? page1 : page0));
    const { messages, complete } = await real.listInbound(shapes.account, { since: new Date(0), until: new Date(), maxPages: 5, to: shapes.sender });
    expect(complete).toBe(true);
    if (page0.next_page_uri) expect(urls[1]).toBe(`https://api.twilio.com${page0.next_page_uri}`);
    const listed = [...page0.messages, ...(page1?.messages ?? [])].filter((m) => m.direction === "inbound");
    expect(messages.map((m) => m.sid)).toEqual(listed.map((m) => m.sid));
    for (const m of messages) {
      expect(m.sid).toMatch(MESSAGE_SID);
      expect(m.date_created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});

describe.each([sources[0]])("Message list (%s shapes): inbound recovery reads documented pages", (_name, shapes) => {
  const page0 = shapes.list_inbound.page0;
  const page1 = shapes.list_inbound.page1;
  const listing = () => provider((url) => (url.includes("PageToken=") ? page1 : page0));
  const window = { since: new Date("2026-11-14T14:00:00Z"), until: new Date("2026-11-14T16:00:00Z"), maxPages: 5, to: shapes.sender };

  it("follows Twilio's own next_page_uri (encoded filters + PageToken) on api.twilio.com and keeps only inbound messages", async () => {
    const { real, urls } = listing();
    const { messages, complete } = await real.listInbound(shapes.account, window);
    expect(complete).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(`https://api.twilio.com${page0.next_page_uri}`);
    const first = new URL(urls[0]);
    expect(first.searchParams.get("To")).toBe(shapes.sender);
    expect(first.searchParams.get("DateSent>")).toBe("2026-11-14T13:59:59Z");
    expect(first.searchParams.get("DateSent<")).toBe("2026-11-14T16:00:01Z");
    const all = [...page0.messages, ...page1.messages];
    const inbound = all.filter((m) => m.direction === "inbound");
    expect(all.some((m) => m.direction === "outbound-reply")).toBe(true);   // Advanced Opt-Out's own confirmation is in the list, and skipped
    expect(messages.map((m) => m.sid)).toEqual(inbound.map((m) => m.sid));
    for (const m of messages) {
      expect(m.sid).toMatch(MESSAGE_SID);
      expect(m.date_created).toMatch(/Z$/);
    }
  });

  it("a next page that points at another account is refused, never followed", async () => {
    const other = { ...page0, next_page_uri: page0.next_page_uri.replace(shapes.account, `AC${"9".repeat(32)}`) };
    const { real } = provider(() => other);
    await expect(real.listInbound(shapes.account, window)).rejects.toThrow("usage_evidence_mismatch");
  });

  it("documented inbound bodies classify fail-safe: STOP is compliance, an MMS with no text and a short text are never ordinary", async () => {
    const { real } = listing();
    const { messages } = await real.listInbound(shapes.account, window);
    const byBody = (b: string) => messages.find((m) => m.body === b) as InboundMessageEvidence;
    expect(classifyRecoveredBody(byBody("STOP").body)).toMatchObject({ classification: "compliance", keywordKind: "stop" });
    expect(classifyRecoveredBody(byBody("").body).classification).toBe("uncertain");
    expect(classifyRecoveredBody(byBody("See you Thursday!").body).classification).toBe("uncertain");
  });

  it("consent order uses Twilio's own times from the documented list: a START sent after the STOP wins; one sent before it does not", async () => {
    const stop = page0.messages[0];
    const atStop = Date.parse(String(stop.date_created));
    const start = (created: string) => ({ ...page1.messages[1], sid: `SM${"7".repeat(32)}`, body: "UNSTOP", from: shapes.texter, date_created: created, date_sent: created });
    for (const [created, expected] of [["Sat, 14 Nov 2026 15:25:00 +0000", "start"], ["Sat, 14 Nov 2026 15:10:00 +0000", "none"]] as const) {
      const { real } = provider(() => ({ ...page1, messages: [stop, start(created)], next_page_uri: null }));
      const kind = await laterKeywordFor(real, { accountSid: shapes.account, to: shapes.sender, from: shapes.texter, sid: String(stop.sid), at: atStop, until: new Date("2026-11-14T16:00:00Z") });
      expect(kind).toBe(expected);
    }
  });
});

describe("date forms agree with Twilio's own helper library (twilio-node)", () => {
  it("the list filter is sent exactly as twilio-node serializes DateSent> / DateSent<, and every documented date parses as twilio-node parses it", async () => {
    const { iso8601DateTime } = await import("twilio/lib/base/serialize");
    const { rfc2822DateTime } = await import("twilio/lib/base/deserialize");
    const since = new Date("2026-11-14T14:00:00.250Z");
    const until = new Date("2026-11-14T16:00:00.900Z");
    const { real, urls } = provider(() => ({ messages: [], next_page_uri: null }));
    await real.listInbound(documented.account, { since, until, maxPages: 1 });
    const query = new URL(urls[0]).searchParams;
    // one second of margin each side, then twilio-node's exact form (whole seconds, UTC, trailing Z)
    expect(query.get("DateSent>")).toBe(iso8601DateTime(new Date(Math.floor((since.getTime() - 1000) / 1000) * 1000)));
    expect(query.get("DateSent<")).toBe(iso8601DateTime(new Date(Math.floor((until.getTime() + 1000) / 1000) * 1000)));
    const text = readFileSync(path.join(dir, "documentedShapes.json"), "utf8");
    const dates = text.match(/"(?:date_created|date_sent|date_updated)": "([^"]+)"/g)!.map((m) => m.split(": ")[1].slice(1, -1));
    expect(dates.length).toBeGreaterThan(10);
    for (const d of dates) expect(new Date(Date.parse(d)).toISOString()).toBe((rfc2822DateTime(d) as Date).toISOString());
  });
});

describe("every documented Message status has a defined outcome", () => {
  const settle = (() => {
    const sql = readFileSync(path.join(process.cwd(), "src/lib/supabase/migrations/20261205090000_twilio_usage_reconciliation.sql"), "utf8");
    const body = sql.slice(sql.indexOf("function public.tw4_usage_settle("));
    const list = (re: RegExp) => (body.match(re)?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
    return {
      pending: list(/v_pending := v_status in \(([^)]*)\)/),
      release: list(/if v_status in \(([^)]*)\) then\s+perform public\._tw4us_release_reservation/),
      charge: list(/elsif v_status in \(([^)]*)\) or \(v_status = 'sent'/),
    };
  })();
  // inbound-only statuses (an outbound text never reports them) and the deprecated partially_delivered: settle sends them to a person (review)
  const reviewed = new Set(["receiving", "received", "partially_delivered"]);

  it("the settle status lists were read from the migration (a parse failure is loud)", () => {
    expect(settle.pending).toEqual(expect.arrayContaining(["accepted", "queued", "sent"]));
    expect(settle.release).toEqual(["failed", "canceled"]);
    expect(settle.charge).toEqual(expect.arrayContaining(["delivered", "undelivered"]));
  });

  it.each(documented.documented_statuses)("%s: the database settles, releases, waits or sends it to review — never guesses", (status) => {
    const buckets = [settle.pending.includes(status), settle.release.includes(status), settle.charge.includes(status)].filter(Boolean).length;
    expect(buckets).toBe(reviewed.has(status) ? 0 : 1);
  });

  it("the message log mapping covers every documented outbound status", () => {
    const expected: Record<string, string> = {
      queued: "queued", sending: "queued", accepted: "queued", scheduled: "queued", sent: "sent", delivered: "delivered", read: "delivered",
      failed: "failed", undelivered: "failed", canceled: "failed", received: "received",
    };
    for (const [status, log] of Object.entries(expected)) expect(mapTwilioStatusToSmsLogStatus(status)).toBe(log);
  });

  it("callbacks in any order never move the log backwards (Twilio does not guarantee callback order)", () => {
    // queued < sent < failed < delivered (delivered is final; a failed log may still be delivered)
    const rank: Record<string, number> = { draft: 0, queued: 0, sent: 1, failed: 2, delivered: 3 };
    const outbound = documented.documented_statuses.filter((s) => !reviewed.has(s));
    for (const first of outbound) {
      for (const second of outbound) {
        const before = mapTwilioStatusToSmsLogStatus(first);
        const next = mapTwilioStatusToSmsLogStatus(second);
        const after = smsLogStatusesReplaceableBy(next).includes(before) ? next : before;
        expect(rank[after]).toBeGreaterThanOrEqual(rank[before]);
        if (before === "delivered") expect(after).toBe("delivered");
      }
    }
    // suppressed and inbound logs are never changed by a callback
    for (const status of documented.documented_statuses) {
      const allowed = smsLogStatusesReplaceableBy(mapTwilioStatusToSmsLogStatus(status));
      expect(allowed).not.toContain("suppressed");
      if (mapTwilioStatusToSmsLogStatus(status) !== "received") expect(allowed).not.toContain("received");
    }
  });
});
