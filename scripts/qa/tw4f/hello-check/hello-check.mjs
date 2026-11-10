#!/usr/bin/env node
/**
 * TW-4F real-authenticator check (LOCAL, disposable QA database only). Registers a REAL passkey (Windows Hello or a security key) on http://localhost:<port> and makes it sign several
 * challenges that the database's own verifier (_tw4price_attest_begin / _tw4price_attest_finish, i.e. _tw4price_check_assertion) judges: signature, origin, relying-party hash,
 * user presence and verification, backup-eligible / backed-up flags, and the signature counter (a counter that stays 0 is reported, a counter that moves must keep increasing).
 *
 *   node scripts/qa/tw4f/hello-check/hello-check.mjs <qa-container> [--port 5173] [--assertions 4]
 *
 * It refuses any container that lacks the public.tw4_local_qa_only marker table, and it only ever calls `docker exec` on that container: it can never reach a hosted project.
 * The passkey it creates is bound to the relying party id "localhost" and is useless for the real site. The owner approves each Windows Hello prompt.
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const container = argv[0];
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(flag("--port", "5173"));
const ROUNDS = Number(flag("--assertions", "4"));
// OBSERVE mode (default): the database policy is unchanged (synced / backup-eligible credentials refused). --allow-synced flips allow_backup_eligible in THIS local QA database only, to see what a
// synced passkey (for example an Android phone) would do end to end: user verification, counter behaviour, proof. It never touches any hosted database.
const ALLOW_SYNCED = argv.includes("--allow-synced");
if (!container || !/^[A-Za-z0-9_.-]+$/.test(container)) {
  console.error("usage: hello-check.mjs <qa-container> [--port n] [--assertions n]");
  process.exit(2);
}
const psql = (sql) => execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD=postgres", container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8" }).trim();
if (psql("select to_regclass('public.tw4_local_qa_only') is not null") !== "t") {
  console.error("refusing: the database has no tw4_local_qa_only marker (not a local QA database)");
  process.exit(2);
}
const ORIGIN = `http://localhost:${PORT}`;
const RP = "localhost";
const hex = (b64u) => Buffer.from(b64u, "base64url").toString("hex");
const results = { startedAt: new Date().toISOString(), origin: ORIGIN, rp: RP, policyAllowSynced: ALLOW_SYNCED, registration: null, assertions: [] };
let cred = null;

function resetAndBootstrap(credId, spkiB64u) {
  const spki = Buffer.from(spkiB64u, "base64url");
  const raw = spki.subarray(spki.length - 65);
  if (raw[0] !== 4) throw new Error("not an uncompressed P-256 key");
  const x = raw.subarray(1, 33).toString("hex");
  const y = raw.subarray(33, 65).toString("hex");
  // owner-level, visible, QA only: start from an unbootstrapped authorization (guards switched off for this statement block and back on ALWAYS)
  psql(`begin;
    alter table public.studio_sms_price_credentials disable trigger studio_sms_price_credentials_guard;
    alter table public.studio_sms_price_auth_config disable trigger studio_sms_price_auth_config_guard;
    delete from public.studio_sms_price_credentials;
    update public.studio_sms_price_auth_config set rp_id = null, rp_origins = null, allow_backup_eligible = ${ALLOW_SYNCED} where singleton;
    alter table public.studio_sms_price_credentials enable always trigger studio_sms_price_credentials_guard;
    alter table public.studio_sms_price_auth_config enable always trigger studio_sms_price_auth_config_guard;
    select public._tw4price_bootstrap('${RP}', array['${ORIGIN}'], decode('${hex(credId)}', 'hex'), decode('${x}', 'hex'), decode('${y}', 'hex'), 'real authenticator check');
  commit;`);
  cred = { id: credId, hex: hex(credId) };
}

function attestBegin() {
  return JSON.parse(psql(`select public._tw4price_attest_begin(decode('${cred.hex}', 'hex'))::text`).split("\n").filter(Boolean).pop());
}
function attestFinish(nonceB64u, auth, client, sig) {
  const u = (s) => `public._tw4price_unb64u('${s}')`;
  return psql(`select coalesce(public._tw4price_attest_finish(decode('${cred.hex}', 'hex'), ${u(nonceB64u)}, ${u(auth)}, ${u(client)}, ${u(sig)}), 'UNEXPECTED_NULL')`).split("\n").filter(Boolean).pop();
}
const counterOf = (authB64u) => Buffer.from(authB64u, "base64url").readUInt32BE(33);
const flagsOf = (authB64u) => {
  const f = Buffer.from(authB64u, "base64url")[32];
  return { up: !!(f & 1), uv: !!(f & 4), be: !!(f & 8), bs: !!(f & 16) };
};

const PAGE = `<!doctype html><meta charset=utf-8><title>TW-4F real authenticator check</title>
<body style="font-family:system-ui;max-width:48rem;margin:2rem auto;padding:0 1rem">
<h1>TW-4F real authenticator check</h1>
<p>Local only (localhost). Click the button, then approve each Windows Hello prompt (1 registration, then ${ROUNDS} signatures). Nothing here touches the real site.</p>
<button id=go style="padding:.6rem 1rem;font-size:1rem">Run the check</button>
<pre id=out style="background:#f4f4f5;padding:1rem;white-space:pre-wrap"></pre>
<script>
const b64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const unb=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0)).buffer};
const log=t=>{out.textContent+=t+'\\n'};
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const ATT=new URLSearchParams(location.search).get('attachment')||'platform';let TRANSPORTS=[];
go.onclick=async()=>{go.disabled=true;out.textContent='';log('requested authenticator type: '+ATT+' (platform = Windows Hello on this PC; hint client-device)');
 try{
  log('1. registering a device-bound passkey (approve Windows Hello)...');
  const c=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{name:'TW-4F check',id:'${RP}'},user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'tw4f-check',displayName:'tw4f-check'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{authenticatorAttachment:ATT,userVerification:'required',residentKey:'discouraged'},hints:ATT=='platform'?['client-device']:[],attestation:'none',timeout:120000}});
  const r=c.response;TRANSPORTS=r.getTransports?r.getTransports():[];const reg=await post('/register',{credId:b64u(c.rawId),spki:b64u(r.getPublicKey()),auth:b64u(r.getAuthenticatorData()),attachment:c.authenticatorAttachment||null,transports:r.getTransports?r.getTransports():[]});
  log('   registered; flags: '+JSON.stringify(reg.flags)+'; attachment: '+reg.attachment);
  for(let i=1;i<=${ROUNDS};i++){
   const b=await post('/begin',{});
   log('2.'+i+' signing challenge '+i+' (approve Windows Hello)...');
   const g=await navigator.credentials.get({publicKey:{challenge:unb(b.challenge),rpId:'${RP}',allowCredentials:[{type:'public-key',id:unb(b.credentialId),transports:TRANSPORTS.length?TRANSPORTS:(ATT=='platform'?['internal']:undefined)}],userVerification:'required',hints:ATT=='platform'?['client-device']:[],timeout:120000}});
   const a=g.response;const res=await post('/finish',{nonce:b.nonce,auth:b64u(a.authenticatorData),client:b64u(a.clientDataJSON),sig:b64u(a.signature)});
   log('   database verdict (attested = accepted): '+res.verdict+'; counter '+res.counter+'; flags '+JSON.stringify(res.flags));
  }
  const s=await post('/summary',{});log('\\nSUMMARY\\n'+JSON.stringify(s,null,2));
 }catch(e){log('FAILED: '+e.name+': '+e.message)}
 go.disabled=false};
</script>`;

const json = (res, o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => ok(s ? JSON.parse(s) : {})); });

createServer(async (req, res) => {
  try {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); return; }
    const b = await body(req);
    if (req.url === "/register") {
      const fl = flagsOf(b.auth);
      resetAndBootstrap(b.credId, b.spki);
      results.registration = { flags: fl, attachment: b.attachment, transports: b.transports, counterAtRegistration: counterOf(b.auth) };
      json(res, { flags: fl, attachment: b.attachment });
    } else if (req.url === "/begin") {
      const x = attestBegin();
      json(res, { nonce: x.nonce, challenge: x.challenge, credentialId: x.credential_id });
    } else if (req.url === "/finish") {
      const verdict = attestFinish(b.nonce, b.auth, b.client, b.sig);
      const counter = counterOf(b.auth);
      const flags = flagsOf(b.auth);
      results.assertions.push({ verdict, counter, flags });
      json(res, { verdict, counter, flags });
    } else if (req.url === "/summary") {
      const accepted = results.assertions.filter((a) => a.verdict === "attested").length;
      const counters = results.assertions.map((a) => a.counter);
      const allZero = counters.length > 0 && counters.every((c) => c === 0);
      const increasing = counters.every((c, i) => i === 0 || c > counters[i - 1]);
      const deviceBound = results.assertions.every((a) => !a.flags.be && !a.flags.bs) && results.registration && !results.registration.flags.be && !results.registration.flags.bs;
      results.summary = {
        assertions: results.assertions.length, acceptedByDatabase: accepted, userVerifiedEveryTime: results.assertions.every((a) => a.flags.uv && a.flags.up), notReportedSynced: !!deviceBound, policyAllowSynced: ALLOW_SYNCED,
        counters, counterBehaviour: allZero ? "always 0 (no clone detection by counter; accepted, documented)" : increasing ? "increasing (clone detection active)" : "NOT monotonic (investigate)",
        storedCounterInDatabase: Number(psql(`select sign_count from public.studio_sms_price_credentials where credential_id = decode('${cred.hex}', 'hex')`)),
        proofRecorded: psql(`select proof_verified_at is not null from public.studio_sms_price_credentials where credential_id = decode('${cred.hex}', 'hex')`) === "t",
      };
      results.finishedAt = new Date().toISOString();
      writeFileSync(`hello-check-result-${Date.now()}.json`, JSON.stringify(results, null, 2));
      console.log(JSON.stringify(results.summary, null, 2));
      json(res, results.summary);
    } else { res.writeHead(404); res.end(); }
  } catch (e) {
    console.error("error:", String(e.message).slice(0, 300));
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`hello-check listening on ${ORIGIN} (database container ${container}); policy: ${ALLOW_SYNCED ? "synced credentials ALLOWED (local QA experiment)" : "synced credentials REFUSED (production policy)"}`));
