import type { Page } from "@playwright/test";

/**
 * Public Event Registration E2E Harness -- Slice 2.
 *
 * `/api/events/cart/checkout` rate-limits by source IP (8 requests per 15
 * minutes -- src/app/api/events/cart/checkout/route.ts's own, already-
 * shipped anti-abuse limit, unrelated to and untouched by this harness).
 * Repeated E2E runs from the same local machine share one IP and would
 * otherwise start tripping that limit and hitting 429s a handful of runs
 * in. Giving each test its own synthetic `x-forwarded-for` value keeps
 * E2E runs independent of both each other and of prior runs, without
 * touching the rate limiter itself -- the real production limit stays
 * exactly as strict for a genuine single IP.
 */
export async function useUniqueE2ESourceIp(page: Page) {
  const syntheticIp = `10.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  await page.setExtraHTTPHeaders({ "x-forwarded-for": syntheticIp });
}
