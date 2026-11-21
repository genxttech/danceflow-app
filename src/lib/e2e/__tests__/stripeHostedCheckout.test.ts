import { describe, expect, it } from "vitest";
import { assertHostedCheckoutUrl, browserEnv, describeUrlShape, detectChallenge, driveHostedCheckout, isAllowedHost, isLoopbackHost, TEST_CARD, type HostedPage } from "../stripeHostedCheckout";

const URL_OK = "https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0";
const SUCCESS = "http://127.0.0.1:3000/cf1-canary?session=";

type Opts = { missing?: string[]; challengeAtOpen?: boolean; challengeAfterPay?: boolean; reachSuccess?: boolean; noPay?: boolean };
function fakePage(o: Opts = {}) {
  const log: string[] = [];
  const filled: Record<string, string> = {};
  let paid = false;
  const page: HostedPage = {
    open: async (url) => { log.push(`open:${url.split("#")[0]}`); },
    fillFirst: async (selectors, value) => { const key = selectors[0]; if (o.missing?.includes(key)) return false; filled[key] = value; return true; },
    clickFirst: async () => { if (o.noPay) return false; log.push("click"); paid = true; return true; },
    uncheckFirst: async () => true,
    frameUrls: () => ((o.challengeAtOpen && !paid) || (o.challengeAfterPay && paid) ? ["https://newassets.hcaptcha.com/captcha/v1/x"] : ["https://js.stripe.com/v3/elements-inner.html"]),
    bodyText: async () => "Pay $1.00",
    currentUrl: () => "https://checkout.stripe.com/c/pay/cs_test_a1B2c3",
    waitForUrlPrefix: async () => (o.reachSuccess ?? true) && paid,
    wait: async () => undefined,
  };
  return { page, log, filled };
}

describe("hosted Checkout URL and network boundaries", () => {
  it("accepts only an https checkout.stripe.com TEST session and never echoes the URL", () => {
    expect(assertHostedCheckoutUrl(URL_OK)).toBe("cs_test_a1B2c3");
    const bad = [undefined, null, "", "http://checkout.stripe.com/c/pay/cs_test_x", "https://checkout.stripe.com/c/pay/cs_live_x#f", "https://checkout.stripe.com.evil.example/c/pay/cs_test_x", "https://evil.example/c/pay/cs_test_x", "https://checkout.stripe.com/c/pay/cs_test_x/../../y", "https://user@checkout.stripe.com/c/pay/cs_test_x"];
    for (const url of bad) expect(() => assertHostedCheckoutUrl(url)).toThrow();
    try { assertHostedCheckoutUrl("https://evil.example/c/pay/cs_test_SECRETFRAGMENT#frag"); } catch (e) { expect(String((e as Error).message)).not.toMatch(/SECRETFRAGMENT|#frag/); }
  });
  it("does NOT accept the unobserved legacy /pay/ layout, and accepts underscores in the id only because the existing harness pattern allows them", () => {
    expect(() => assertHostedCheckoutUrl("https://checkout.stripe.com/pay/cs_test_a1B2c3#fidkd")).toThrow(/refusing/);
    expect(assertHostedCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_a1_B2c3#fidkd")).toBe("cs_test_a1_B2c3");
  });
  const leaks = (url: string) => { let m = ""; try { assertHostedCheckoutUrl(url); } catch (e) { m = (e as Error).message; } return m; };
  it("a refusal prints only fixed words: scheme, the host checkout.stripe.com, and the segments c and pay; everything else is a category and a length", () => {
    const m = leaks("https://checkout.stripe.com/c/pay/cs_live_abcdef?x=1#frag");
    expect(m).toContain("(seen: scheme=https host=checkout.stripe.com path=/c/pay/<LIVE session id, 14 chars> userinfo=no port=no query=yes fragment=yes)");
    expect(describeUrlShape(null)).toBe("not a string (null)");
    expect(describeUrlShape(undefined)).toBe("not a string (undefined)");
  });
  it("short lowercase secrets in the host, path, query, fragment or userinfo are never printed (they were the gap in the first version)", () => {
    const secrets = ["abc", "tok", "secretz", "hunter2", "zzzqqq", "pw"];
    const urls = [
      "https://abc.tok.example.com/secretz/hunter2?zzzqqq=pw#pw",
      "https://user:pw@checkout.stripe.com/abc/c/tok/pay/secretz/cs_test_hunter2",
      "https://sub.stripe.com/abc/secretz?tok=hunter2#zzzqqq",
      "http://hunter2.checkout.stripe.com/c/pay/cs_test_zzzqqq",
      "https://checkout.stripe.com:8443/c/pay/abc/def/ghi/jkl/mno/pqr/stu",
    ];
    for (const url of urls) {
      const m = leaks(url);
      expect(m, url).toMatch(/\(seen: scheme=/);
      for (const secret of secrets) expect(m.replace(/not https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_\.\.\./, ""), `${url} leaked ${secret}`).not.toContain(secret);
    }
    expect(leaks(urls[0])).toContain("host=<non-Stripe host, 19 chars, 4 labels> path=/<other, 7 chars>/<other, 7 chars> userinfo=no port=no query=yes fragment=yes");
    expect(leaks(urls[2])).toContain("host=<other Stripe-owned host, 14 chars, 3 labels>");
  });
  it("long identifiers, session ids and fragments are never printed either, and a very long path is truncated", () => {
    const id = "cs_test_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ";
    const frag = "fidkdWxOYHwnPyd1blpxYHZxWjA0LONGFRAGMENT";
    const m = leaks(`https://checkout.stripe.com/c/pay/${id}/extra/more/more/more/more/more#${frag}`);
    expect(m).not.toContain(id);
    expect(m).not.toContain(frag);
    expect(m).not.toContain("extra");
    expect(m).toMatch(/<\d+ more>/);
  });
  it("unparseable input is described by length only", () => {
    expect(describeUrlShape("not a url secretvalue")).toBe("unparseable (21 chars)");
  });
  it("allows only Stripe hosts and the loopback", () => {
    for (const h of ["checkout.stripe.com", "js.stripe.com", "m.stripe.network", "q.stripecdn.com", "stripe.com"]) expect(isAllowedHost(h), h).toBe(true);
    for (const h of ["evil.com", "stripe.com.evil.com", "notstripe.com", "stripe.network.evil.io", "hcaptcha.com"]) expect(isAllowedHost(h), h).toBe(false);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("evil.com")).toBe(false);
  });
  it("gives the browser no Stripe key or other secret", () => {
    const env = browserEnv({ PATH: "/usr/bin", HOME: "/h", LANG: "C", E2E_STRIPE_TEST_SECRET_KEY: "rk_test_x", GITHUB_TOKEN: "t", NODE_OPTIONS: "--require x" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", LANG: "C" });
  });
  it("detects captcha, 3-D Secure and authentication prompts and ignores the normal page", () => {
    expect(detectChallenge(["https://newassets.hcaptcha.com/captcha/v1/x"], "")).toMatch(/challenge/);
    expect(detectChallenge([], "Please complete the security check to continue")).toMatch(/security check/);
    expect(detectChallenge([], "Additional authentication required")).not.toBeNull();
    expect(detectChallenge(["https://js.stripe.com/v3/elements-inner.html", "https://m.stripe.network/inner.html"], "Pay $1.00 Email Card information")).toBeNull();
  });
});

describe("driveHostedCheckout", () => {
  it("fills the documented TEST card, pays, and returns when the success page is reached", async () => {
    const { page, log, filled } = fakePage();
    await driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS, timeoutMs: 6000 });
    expect(log).toEqual(["open:https://checkout.stripe.com/c/pay/cs_test_a1B2c3", "click"]);
    expect(filled["#cardNumber"]).toBe(TEST_CARD.number);
    expect(TEST_CARD.number).toBe("4242424242424242");
    expect(filled["#cardCvc"]).toBe("123");
  });
  it("refuses a non-Checkout URL before opening anything", async () => {
    const { page, log } = fakePage();
    await expect(driveHostedCheckout(page, "https://evil.example/", { successPrefix: SUCCESS })).rejects.toThrow(/refusing/);
    expect(log).toEqual([]);
  });
  it("names the missing field when the page layout does not match, and never pays", async () => {
    const { page, log } = fakePage({ missing: ["#cardNumber"] });
    await expect(driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS })).rejects.toThrow(/card number field was not found/);
    expect(log).not.toContain("click");
  });
  it("reports a missing pay button", async () => {
    const { page } = fakePage({ noPay: true });
    await expect(driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS })).rejects.toThrow(/pay button was not found/);
  });
  it("a challenge before entry is INCONCLUSIVE and nothing is typed", async () => {
    const { page, filled } = fakePage({ challengeAtOpen: true });
    await expect(driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS })).rejects.toThrow(/^INCONCLUSIVE: .*before payment details/);
    expect(filled).toEqual({});
  });
  it("a challenge after submitting is INCONCLUSIVE, not a pass and not a bypass", async () => {
    const { page, log } = fakePage({ challengeAfterPay: true, reachSuccess: false });
    await expect(driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS, timeoutMs: 6000 })).rejects.toThrow(/^INCONCLUSIVE: .*after submitting/);
    expect(log.filter((l) => l === "click")).toHaveLength(1);
  });
  it("never reaching the success page times out with an explicit failure", async () => {
    const { page } = fakePage({ reachSuccess: false });
    await expect(driveHostedCheckout(page, URL_OK, { successPrefix: SUCCESS, timeoutMs: 6000 })).rejects.toThrow(/success page was not reached within 6s/);
  });
});
