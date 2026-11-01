/**
 * D4-2 price monitor operator tool. Uses the PRICE_MONITOR_* environment (the same values the cron route reads) and the service-role environment
 * (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) of the database it should record evidence in.
 *
 *   npm run qa:price-monitor -- send                         signed TEST message to every destination; webhook receipts are verified at once
 *   npm run qa:price-monitor -- confirm --nonce N --token T  out-of-band confirmation (token from the mailbox / dead-man page)
 *   npm run qa:price-monitor -- list-undelivered             alerts that no destination accepted (read only)
 *   npm run qa:price-monitor -- redeliver                    re-send them; adds evidence rows, edits none
 *
 * Exit codes: 0 confirmed / done, 1 failed or something undelivered remains, 3 pending out-of-band confirmation, 2 usage. Prints codes and counts, never secrets or URLs.
 * It never reads or writes a price. Run it against production only with the owner's written authorization.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createPriceMonitorDb } from "@/lib/sms/pricing/db";
import { listUndelivered, redeliverUndelivered } from "@/lib/sms/pricing/ops";
import { loadMonitorConfig } from "@/lib/sms/pricing/transport";
import { confirmDeliveryVerification, startDeliveryVerification } from "@/lib/sms/pricing/verifyDelivery";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const config = loadMonitorConfig(process.env);
  const db = createPriceMonitorDb(createAdminClient());
  const secret = process.env.PRICE_MONITOR_WEBHOOK_HMAC_SECRET?.trim() || process.env.PRICE_MONITOR_CHAIN_KEY?.trim() || null;
  if (cmd === "send") {
    const out = await startDeliveryVerification({ db, config, secret });
    console.log(JSON.stringify(out));
    if (out.status === "pending") console.log(`Confirm with: confirm --nonce ${out.nonce} --token <token shown in the received message>`);
    return out.status === "confirmed" ? 0 : out.status === "pending" ? 3 : 1;
  }
  if (cmd === "confirm") {
    const nonce = opt("--nonce"), token = opt("--token");
    if (!nonce || !token) { console.error("confirm needs --nonce and --token"); return 2; }
    const out = await confirmDeliveryVerification({ db, config, secret }, { nonce, token });
    console.log(JSON.stringify(out));
    return out.confirmed ? 0 : 1;
  }
  if (cmd === "list-undelivered") {
    const out = await listUndelivered({ db, config });
    console.log(JSON.stringify(out));
    return out.undelivered.length ? 1 : 0;
  }
  if (cmd === "redeliver") {
    const out = await redeliverUndelivered({ db, config });
    console.log(JSON.stringify(out));
    return out.failed || !out.recorded ? 1 : 0;
  }
  console.error("usage: send | confirm --nonce N --token T | list-undelivered | redeliver");
  return 2;
}

main().then((code) => process.exit(code), () => { console.error("price_monitor_ops_failed"); process.exit(1); });
