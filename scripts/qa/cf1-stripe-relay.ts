/**
 * CF1 Stripe-TEST acceptance: Connect event relay (process). See src/lib/e2e/stripeRelay.ts and
 * docs/qa/cf1-stripe-test/STRIPE_TEST_ACCEPTANCE_PACKAGE.md.
 *
 * Reads the connected account's events with the TEST key and POSTs each, signed with the local connect secret, to the local app's
 * webhook route. Run it next to the app for the duration of the acceptance run; stop it with SIGTERM.
 *
 * Note: while the pause file exists the loop idles without spending polls, so the job timeout (not CF1_RELAY_MAX_POLLS) bounds a stuck pause; the spec removes the file in finally/afterAll.
 * Environment (nothing is logged or written except counters):
 *   E2E_STRIPE_TEST_SECRET_KEY         sk_test_/rk_test_ (the same key the harness uses)
 *   E2E_STRIPE_TEST_CONNECTED_ACCOUNT  acct_...
 *   CF1_RELAY_WEBHOOK_SECRET           the value the app was started with as STRIPE_CONNECT_WEBHOOK_SECRET
 *   CF1_RELAY_TARGET                   default http://127.0.0.1:3000/api/payments/webhook (loopback only)
 *   CF1_RELAY_PAUSE_FILE               optional: while this file exists nothing is delivered (tests use it for out-of-order delivery)
 *   CF1_RELAY_POLL_MS                  default 3000
 *   CF1_RELAY_MAX_POLLS                default 1500 (about 75 minutes); this is the relay's own Stripe request budget
 *   CF1_RELAY_STATS_FILE               optional: counters JSON written at exit (no secrets, no bodies)
 */
import { existsSync, writeFileSync } from "node:fs";
import Stripe from "stripe";
import { assertRelayTarget, assertTestKey, runRelay, type RelayEvent } from "../../src/lib/e2e/stripeRelay";

async function main() {
  const key = process.env.E2E_STRIPE_TEST_SECRET_KEY ?? "";
  const account = process.env.E2E_STRIPE_TEST_CONNECTED_ACCOUNT ?? "";
  const secret = process.env.CF1_RELAY_WEBHOOK_SECRET ?? "";
  const url = process.env.CF1_RELAY_TARGET ?? "http://127.0.0.1:3000/api/payments/webhook";
  const pauseFile = process.env.CF1_RELAY_PAUSE_FILE ?? "";
  const pollMs = Number(process.env.CF1_RELAY_POLL_MS ?? 3000);
  const maxPolls = Number(process.env.CF1_RELAY_MAX_POLLS ?? 1500);

  assertTestKey(key);
  assertRelayTarget(url);
  if (!/^acct_[A-Za-z0-9]+$/.test(account)) throw new Error("refusing: connected account id");
  if (secret.length < 16) throw new Error("refusing: CF1_RELAY_WEBHOOK_SECRET is missing or too short");
  if (!Number.isFinite(pollMs) || pollMs < 500 || !Number.isInteger(maxPolls) || maxPolls < 1) throw new Error("refusing: poll settings");

  const stripe = new Stripe(key);
  const balance = await stripe.balance.retrieve();
  if (balance.livemode) throw new Error("refusing: the Stripe key is a live key");

  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });

  const startedAtSeconds = Math.floor(Date.now() / 1000);
  console.log(`relay: started, target ${new URL(url).origin}${new URL(url).pathname}, poll ${pollMs} ms, max ${maxPolls} polls`);

  const stats = await runRelay({
    url, secret, account, startedAtSeconds, pollMs, maxPolls,
    deps: {
      listEvents: async (sinceSeconds) => {
        const events: RelayEvent[] = [];
        for await (const item of stripe.events.list({ created: { gte: sinceSeconds }, limit: 100 }, { stripeAccount: account })) events.push(item as unknown as RelayEvent);
        return events;
      },
      post: async ({ url: target, body, signature }) => {
        const response = await fetch(target, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": signature }, body });
        await response.text();
        return response.status;
      },
      isPaused: () => (pauseFile ? existsSync(pauseFile) : false),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => stop,
      log: (line) => console.log(line),
    },
  });

  console.log(`relay: finished ${JSON.stringify(stats)}`);
  if (process.env.CF1_RELAY_STATS_FILE) writeFileSync(process.env.CF1_RELAY_STATS_FILE, JSON.stringify({ ...stats, startedAtSeconds }, null, 2));
}

main().catch((error) => {
  console.error(`relay: ${error instanceof Error ? error.message : "failed"}`);
  process.exit(1);
});
