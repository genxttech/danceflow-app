// Runtime network guard v2: loopback always allowed; ONLY the hostnames in NETGUARD_ALLOW are allowed outbound; everything else is blocked and logged.
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const LOG = process.env.NETGUARD_LOG;
const ALLOW = new Set((process.env.NETGUARD_ALLOW || "").split(",").filter(Boolean));
const isLoop = (h) => !h || h === "localhost" || h === "::1" || /^127\./.test(String(h)) || h === "0.0.0.0" || h === "::";
const ok = (h) => isLoop(h) || ALLOW.has(String(h));
const note = (kind, host) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${kind} ${host}\n`); } catch {} };
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0]; let host;
  if (a && typeof a === "object" && !Array.isArray(a)) { if (a.path) return origConnect.apply(this, args); host = a.host || a.hostname; }
  else if (typeof a === "number") host = typeof args[1] === "string" ? args[1] : undefined;
  else if (typeof a === "string") return origConnect.apply(this, args);
  if (!ok(host)) { note("BLOCK connect", host); const e = new Error("netguard: blocked " + host); e.code = "ENETGUARD"; process.nextTick(() => this.destroy(e)); return this; }
  if (!isLoop(host)) note("ALLOW connect", host);
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!ok(host)) { note("BLOCK dns", host); const cb = rest[rest.length - 1]; const e = new Error("netguard: dns blocked " + host); e.code = "ENETGUARD"; if (typeof cb === "function") return process.nextTick(cb, e); throw e; }
  return origLookup.call(this, host, ...rest);
};
const origP = dns.promises.lookup;
dns.promises.lookup = async function (host, ...rest) { if (!ok(host)) { note("BLOCK dns", host); const e = new Error("netguard: dns blocked " + host); e.code = "ENETGUARD"; throw e; } return origP.call(this, host, ...rest); };
note("loaded", (process.argv[1] || "").slice(-40));
