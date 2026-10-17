/* eslint-disable @typescript-eslint/no-require-imports -- a Node --require preload must be CommonJS */
// Preload for the dry-run verification. Local IPC (named pipes) and loopback TCP are allowed and logged as "local";
// any other outbound connection, DNS lookup or fetch is logged as BLOCKED and refused.
const fs = require("fs");
const net = require("net");
const dns = require("dns");
const log = process.env.NETBLOCK_LOG;
const note = (what) => { try { fs.appendFileSync(log, what + "\n"); } catch {} };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", undefined, null, ""]);
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let opts = args[0];
  if (Array.isArray(opts)) opts = opts[0];
  if (typeof opts !== "object" || opts === null) opts = typeof opts === "string" && Number.isNaN(Number(opts)) ? { path: opts } : { port: opts, host: typeof args[1] === "string" ? args[1] : undefined };
  if (opts.path) { note("local-pipe"); return origConnect.apply(this, args); }
  if (LOOPBACK.has(opts.host)) { note("local-loopback " + (opts.host || "default") + ":" + opts.port); return origConnect.apply(this, args); }
  note("BLOCKED socket.connect " + opts.host + ":" + opts.port);
  throw new Error("netblock: outbound connection refused");
};
const origLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (LOOPBACK.has(host)) return origLookup.call(dns, host, ...rest);
  note("BLOCKED dns.lookup " + host);
  throw new Error("netblock: dns refused");
};
const origFetch = globalThis.fetch;
globalThis.fetch = async function (u, init) {
  let host = "";
  try { host = new URL(typeof u === "string" ? u : u instanceof URL ? u.toString() : u.url).hostname; } catch {}
  if (LOOPBACK.has(host)) { note("local-fetch " + host); return origFetch(u, init); }
  note("BLOCKED fetch " + String(u));
  throw new Error("netblock: fetch refused");
};
