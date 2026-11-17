import fs from "fs";
import path from "path";

/*
  Guard: words a dancer reads must not name our vendors (Stripe, Supabase, Twilio, Firebase, Expo, FCM).
  The payment sheet and push come from those providers, but the app's own copy says "your payment" and "notifications".
  Code identifiers (useStripe, StripeProvider), imports, comments and console logging are not user-facing and are skipped.
*/

const VENDOR = /\b(Stripe|Supabase|Twilio|Firebase|Expo|FCM)\b/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "node_modules" ? [] : walk(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

const root = path.resolve(__dirname, "../../..");
const files = [...walk(path.join(root, "app")), ...walk(path.join(root, "src"))];

describe("no vendor names in the app's own wording", () => {
  it("screens and components do not print a vendor name", () => {
    const offenders: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (!VENDOR.test(t)) return;
        if (/^(\/\/|\/\*|\*|import |export .* from )/.test(t) || /console\.(log|warn|error|info)\(/.test(t)) return;
        offenders.push(`${path.relative(root, file).split(path.sep).join("/")}:${i + 1}: ${t.slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
