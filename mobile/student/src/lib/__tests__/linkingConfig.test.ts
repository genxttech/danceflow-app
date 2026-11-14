/*
  No-device checks for the app's links. A device is still needed to prove the OS opens them;
  these prove every link the app hands out points at a route that exists, under a scheme the
  native projects actually register.
*/
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const root = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const appJson = JSON.parse(read("app.json")) as { expo: { scheme: string } };
const scheme = appJson.expo.scheme;

/** Maps a danceflow:// URL to the expo-router screen file that serves it. */
function routeFileFor(url: string) {
  const parsed = new URL(url);
  const path = [parsed.host, ...parsed.pathname.split("/")].filter(Boolean);
  const candidates = [
    join("app", ...path) + ".tsx",
    join("app", ...path, "index.tsx"),
    join("app", "(tabs)", ...path) + ".tsx"
  ];
  return candidates.find((candidate) => existsSync(join(root, candidate)));
}

describe("deep-link configuration", () => {
  it("uses the danceflow scheme", () => {
    expect(scheme).toBe("danceflow");
  });

  it("is registered by the committed Android project, which Android builds use instead of app.json", () => {
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toMatch(/<intent-filter>[\s\S]*android\.intent\.action\.VIEW[\s\S]*BROWSABLE[\s\S]*android:scheme="danceflow"[\s\S]*<\/intent-filter>/);
  });

  it.each([
    ["sign-in email redirect", "src/lib/auth.tsx", "danceflow://auth/callback"],
    ["registration payment return", "app/events/[id]/register.tsx", "danceflow://wallet?checkout=event"],
    ["order payment return", "app/events/orders/[orderId].tsx", "danceflow://events/orders/"]
  ])("%s points at a real screen", (_label, source, url) => {
    expect(read(source)).toContain(url);
    const concrete = url.endsWith("/") ? `${url}example-order` : url;
    expect(concrete.startsWith(`${scheme}://`)).toBe(true);
    const file = routeFileFor(concrete.replace("example-order", "[orderId]"));
    expect(file).toBeDefined();
  });

  it("gives Stripe the same scheme for its redirects", () => {
    expect(read("src/lib/stripeConnect.ts")).toContain(`urlScheme: "${scheme}"`);
  });
});

describe.each(["app/events/[id]/register.tsx", "app/events/orders/[orderId].tsx"])(
  "payment sheet setup in %s",
  (screen) => {
    const source = read(screen);
    const prepare = source.indexOf("await prepareConnectedPaymentSheet(result)");
    const init = source.indexOf("await initPaymentSheet(", prepare);

    it("selects the studio's connected account before creating the sheet", () => {
      expect(prepare).toBeGreaterThan(-1);
      expect(init).toBeGreaterThan(prepare);
    });

    it("does not create the sheet when the account could not be selected", () => {
      expect(source.slice(prepare, init)).toMatch(/prepared\.error \? prepared : $/m);
    });

    it("creates the sheet from the server's PaymentIntent client secret", () => {
      const call = source.slice(init, source.indexOf("});", init));
      expect(call).toContain("paymentIntentClientSecret: result.clientSecret");
    });
  }
);
