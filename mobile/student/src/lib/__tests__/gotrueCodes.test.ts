// What a REAL GoTrue answered (captured by scripts/qa-smoke/gotrue-codes.mjs on a disposable iso-qa stack, name/status/code
// only) must map to the wording the app intends. The fixture is observed data, not an assumption; re-capture it when the
// auth server version changes.
import fixture from "../../../scripts/qa-smoke/gotrue-codes.fixture.json";
import { friendlyAuthLinkError, LINK_EXPIRED_MESSAGE, LINK_FAILED_MESSAGE } from "@/lib/authLink";
import { signInLinkErrorMessage } from "@/lib/errorKind";

type Row = { id: string; name: string | null; status: number | null; code: string | null; ok: boolean };
const rows = (fixture as { rows: Row[] }).rows;
const row = (id: string) => {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`fixture row ${id} missing`);
  return found;
};
// The error object supabase-js hands the app: class name, status and code; the message wording is irrelevant and unrelated here.
const error = (id: string) => {
  const r = row(id);
  return Object.assign(new Error("unrelated vendor wording"), { name: r.name ?? "Error", status: r.status, code: r.code });
};

const RATE = "Too many link requests. Wait a minute, then try again.";
const BAD_ADDRESS = "That email address does not look right. Check it and try again.";
const GENERIC_SEND = "We could not send that link right now. Try again in a moment.";

describe("real GoTrue answers map to the intended wording", () => {
  it("the control (a fresh link) succeeded, so the failures below are real answers", () => {
    expect(row("verify-first-use").ok).toBe(true);
  });

  it.each([
    ["verify-used-link"],
    ["verify-unknown-token"],
    ["verify-deleted-user-link"],
    ["verify-empty-token"],
    ["verify-bad-type"],
    ["exchange-invalid-code"],
  ])("opening a link: %s reads as an unusable link", (id) => {
    expect(friendlyAuthLinkError(error(id))).toBe(LINK_EXPIRED_MESSAGE);
  });

  it("opening a PKCE link on a device without the code verifier gets the generic 'request a new link' wording", () => {
    // client-side error (never reaches GoTrue); the advice, request a new link, is right, so it is not mislabelled as expired.
    expect(friendlyAuthLinkError(error("exchange-no-verifier"))).toBe(LINK_FAILED_MESSAGE);
  });

  it.each([["send-bad-email-no-at"], ["send-bad-email-empty"], ["send-bad-email-spaces"], ["send-bad-email-no-domain"]])(
    "sending a link: %s is a bad address",
    (id) => {
      expect(signInLinkErrorMessage(error(id))).toBe(BAD_ADDRESS);
    },
  );

  it("sending a link: sending again to the same address too soon is the rate-limit wording", () => {
    expect(signInLinkErrorMessage(error("send-repeat-2"))).toBe(RATE);
  });

  it("sending a link: otp_disabled (no account and creation off) is not one the app can trigger and uses the generic wording", () => {
    expect(signInLinkErrorMessage(error("send-no-user-create-off"))).toBe(GENERIC_SEND);
  });

  it("every captured failure is mapped deliberately: no row slips through unclassified", () => {
    const covered = new Set([
      "verify-used-link", "verify-unknown-token", "verify-deleted-user-link", "verify-empty-token", "verify-bad-type", "exchange-invalid-code",
      "exchange-no-verifier", "send-bad-email-no-at", "send-bad-email-empty", "send-bad-email-spaces", "send-bad-email-no-domain",
      "send-repeat-2", "send-no-user-create-off",
    ]);
    const unmapped = rows.filter((r) => !r.ok && !covered.has(r.id)).map((r) => r.id);
    expect(unmapped).toEqual([]);
  });
});
