import http from "node:http";
import type { AddressInfo } from "node:net";
import { STRIPE_API_VERSION } from "../config";

// A loopback (127.0.0.1) HTTP server that RECORDS every request it receives. Tests point the node transport at it to prove, with a real socket, how many
// requests actually leave the client. Nothing here can reach the internet.

export type Recorded = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; socketId: number };
export type Behaviour = "ok" | "reset" | "redirect" | "hang" | "garbage" | "no-version" | "big" | "drip" | "scalar" | "array" | "dupkey";

export async function startLoopback(behaviour: (n: number) => Behaviour = () => "ok") {
  const requests: Recorded[] = [];
  const sockets: Array<import("node:net").Socket> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!sockets.includes(req.socket)) sockets.push(req.socket);
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, socketId: sockets.indexOf(req.socket) });
      const b = behaviour(requests.length);
      if (b === "reset") return void req.socket.destroy();
      if (b === "hang") return; // never answers
      if (b === "drip") {
        res.writeHead(200, { "content-type": "application/json", "stripe-version": STRIPE_API_VERSION });
        const t = setInterval(() => res.write(" "), 40); // a byte every 40 ms for ~3 s: the idle timer never fires, only an absolute deadline can stop it
        setTimeout(() => { clearInterval(t); res.end("{}"); }, 3000);
        res.on("close", () => clearInterval(t));
        return;
      }
      if (b === "redirect") {
        res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere", "stripe-version": STRIPE_API_VERSION });
        return void res.end();
      }
      const headers: Record<string, string> = { "content-type": "application/json", "request-id": `req_loop${requests.length}` };
      if (b !== "no-version") headers["stripe-version"] = STRIPE_API_VERSION;
      if (req.headers["idempotency-key"] && requests.filter((r) => r.headers["idempotency-key"] === req.headers["idempotency-key"]).length > 1) headers["idempotent-replayed"] = "true";
      res.writeHead(200, headers);
      if (b === "garbage") return void res.end("<html>not json</html>");
      if (b === "big") return void res.end("x".repeat(1_100_000));
      if (b === "scalar") return void res.end("5");
      if (b === "dupkey") return void res.end('{"id":"cus_DUP00001","object":"customer","livemode":true,"livemode":false}');
      if (b === "array") return void res.end("[\"cus_ARR00001\"]");
      res.end(JSON.stringify({ id: "acct_LOOPBACK1", object: "account" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
