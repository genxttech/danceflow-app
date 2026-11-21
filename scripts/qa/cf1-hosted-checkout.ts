/**
 * Playwright adapter for src/lib/e2e/stripeHostedCheckout.ts. It launches a browser with a minimal environment (no Stripe key), restricts every request to
 * Stripe's own hosts plus the loopback success page, and hands the page to the tested driver. It decides nothing about payment success.
 * Optional: CF1_CHROME_PATH points at an installed Chrome (the GitHub ubuntu-24.04 image ships one), so nothing is downloaded at run time.
 */
import { chromium, type Page } from "playwright";
import { browserEnv, driveHostedCheckout, isAllowedHost, isLoopbackHost, type HostedPage } from "../../src/lib/e2e/stripeHostedCheckout";

function adapt(page: Page): HostedPage {
  const first = async (selectors: string[]) => {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) return locator;
    }
    return null;
  };
  return {
    open: async (url) => { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => undefined); },
    fillFirst: async (selectors, value) => { const el = await first(selectors); if (!el) return false; await el.fill(value, { timeout: 15_000 }); return true; },
    clickFirst: async (selectors) => { const el = await first(selectors); if (!el) return false; await el.click({ timeout: 15_000 }); return true; },
    uncheckFirst: async (selectors) => { const el = await first(selectors); if (!el) return false; if (await el.isChecked().catch(() => false)) await el.uncheck({ timeout: 5_000 }).catch(() => undefined); return true; },
    frameUrls: () => page.frames().map((f) => f.url()),
    bodyText: async () => (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")),
    currentUrl: () => page.url(),
    waitForUrlPrefix: async (prefix, timeoutMs) => page.waitForURL((u) => u.toString().startsWith(prefix), { timeout: timeoutMs }).then(() => true, () => false),
    wait: (ms) => page.waitForTimeout(ms),
  };
}

/** Opens the hosted Checkout URL in a locked-down browser and pays it with the documented TEST card. Throws on any failure; never prints page text. */
export async function payHostedCheckoutInBrowser(checkoutUrl: string, successPrefix: string): Promise<void> {
  const executablePath = process.env.CF1_CHROME_PATH || undefined;
  const browser = await chromium.launch({ headless: true, executablePath, env: browserEnv(process.env) });
  try {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return route.continue();
      if (url.protocol === "https:" && isAllowedHost(url.hostname)) return route.continue();
      if (route.request().url().startsWith(successPrefix) && isLoopbackHost(url.hostname)) return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    await driveHostedCheckout(adapt(page), checkoutUrl, { successPrefix });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
