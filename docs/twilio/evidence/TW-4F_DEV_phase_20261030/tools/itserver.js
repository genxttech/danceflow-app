// One bounded localhost-only runtime smoke test of the DEV-bound build. GET requests only. Secrets are never printed.
const fs = require("fs"), cp = require("child_process");
const WT = "C:/Dev/studioapp-devpf", D = process.env.TEMP + "/devpf", DEV = "epdrtzcydvnoidwrepqz", PORT = 3017;
const lines = fs.readFileSync("C:/Dev/studioapp/.env.local", "utf8").split(/\r?\n/);
const pick = (k) => { for (const l of lines) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1] === k) return m[2].trim().replace(/^["']|["']$/g, ""); } };
const URLV = pick("NEXT_PUBLIC_SUPABASE_URL"), ANON = pick("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SVC = pick("SUPABASE_SERVICE_ROLE_KEY");
if (!URLV || !ANON || !SVC || new URL(URLV).host !== `${DEV}.supabase.co`) { console.log("STOP: values missing or URL is not DEV"); process.exit(2); }
const GUARDLOG = D + "/netguard-it.log"; fs.rmSync(GUARDLOG, { force: true });
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: process.env.TEMP, TMP: process.env.TMP,
  USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, HOME: process.env.HOME || process.env.USERPROFILE,
  NODE_OPTIONS: "--max-old-space-size=4096 --require <TEMP>/devpf/netguard2.cjs", NEXT_TELEMETRY_DISABLED: "1",
  NETGUARD_LOG: GUARDLOG, NETGUARD_ALLOW: `${DEV}.supabase.co`, NODE_ENV: "production",
  NEXT_PUBLIC_SUPABASE_URL: URLV, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SVC,
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`, NEXT_PUBLIC_SITE_URL: `http://localhost:${PORT}`,
};
console.log("env names passed:", Object.keys(env).join(","));
const red = (t) => [[URLV, "<url>"], [ANON, "<anon>"], [SVC, "<service>"]].reduce((s, [v, r]) => s.split(v).join(r), t);
const logPath = D + "/it-server.log"; fs.writeFileSync(logPath, "");
const child = cp.spawn(process.execPath, [WT + "/node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: WT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
child.stdout.on("data", (d) => fs.appendFileSync(logPath, red(String(d))));
child.stderr.on("data", (d) => fs.appendFileSync(logPath, red(String(d))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
(async () => {
  try {
    let up = false;
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/robots.txt`, { signal: AbortSignal.timeout(3000) }); if (r.status) { up = true; break; } } catch {} await sleep(1000); }
    console.log("server up on 127.0.0.1:" + PORT + ":", up);
    if (!up) throw new Error("server did not start");
    const ns = cp.spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(":" + PORT) && /LISTENING/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(" "));
    console.log("listening sockets for the port:", ns.join(" | "));
    const SLUG = fs.readFileSync(fs.readFileSync(process.env.TEMP + "/tw4f_it_wd.txt", "utf8").trim() + "/fixture_slug.txt", "utf8").trim() || "no-such-studio"; const paths = ["/", "/login", "/sms-consent", `/studios/${SLUG}/sms-privacy`, `/studios/${SLUG}/sms-terms`, "/studios/no-such-studio-smoke/sms-terms", "/platform/sms", "/app/settings/sms", "/app/settings/sms/location", "/api/cron/sms-inventory-reconcile", "/api/cron/sms-usage-reconcile", "/api/cron/sms-provider-fee-lifecycle", "/api/cron/sms-recurring", "/api/cron/sms-sender-reverify", "/api/cron/sms-onboarding-purge", "/api/sms/send", "/api/sms/twilio/inbound", "/api/sms/twilio/status", "/api/billing/sms-credits/checkout", "/api/billing/sms-limits/set", "/api/billing/sms-recurring/authorize"];
    for (const p of paths) {
      const t0 = Date.now(); let r, body = "";
      try { r = await fetch(`http://127.0.0.1:${PORT}${p}`, { redirect: "manual", signal: AbortSignal.timeout(60000) }); body = await r.text(); } catch (e) { results.push({ p, err: e.message }); console.log(p, "ERROR", e.message); continue; }
      const title = (body.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
      const loc = r.headers.get("location") || "";
      const leak = [URLV, ANON, SVC].some((v) => body.includes(v));
      results.push({ p, status: r.status });
      console.log(`GET ${p} -> ${r.status} ${Date.now() - t0}ms bytes=${body.length}${title ? " title=" + JSON.stringify(title.slice(0, 50)) : ""}${loc ? " location=" + loc.replace(/^https?:\/\/[^/]+/, "").split("?")[0] : ""}${leak ? " SECRET-IN-BODY!" : ""}`);
    }
  } catch (e) { console.log("smoke error:", e.message); }
  finally {
    cp.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });
    await sleep(2500);
    let still = false; try { await fetch(`http://127.0.0.1:${PORT}/robots.txt`, { signal: AbortSignal.timeout(2000) }); still = true; } catch {}
    const ns2 = cp.spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.includes(":" + PORT) && /LISTENING/.test(l)).length;
    console.log("after stop: port still answering:", still, "| listening sockets:", ns2);
    const g = fs.existsSync(GUARDLOG) ? fs.readFileSync(GUARDLOG, "utf8").split("\n").filter(Boolean) : [];
    const tally = {}; for (const l of g) { const m = l.match(/(BLOCK|ALLOW) (connect|dns) (\S+)/); if (m) tally[`${m[1]} ${m[2]} ${m[3]}`] = (tally[`${m[1]} ${m[2]} ${m[3]}`] || 0) + 1; }
    console.log("network guard tally:", JSON.stringify(tally));
    const sl = fs.readFileSync(logPath, "utf8");
    console.log("server log: lines=" + sl.split("\n").length, "| error-ish lines:", (sl.match(/error|unhandled|ECONN|ENETGUARD|warn/gi) || []).length);
    console.log("secret values in server log:", [URLV, ANON, SVC].some((v) => sl.includes(v)));
    process.exit(0);
  }
})();
