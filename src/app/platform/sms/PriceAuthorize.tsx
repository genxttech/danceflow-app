"use client";

import { useState } from "react";
import { priceAuthzBegin, priceAuthzFinish } from "./priceChangeActions";
import type { AuthzChallenge } from "@/lib/sms/priceChange";

/**
 * Final authorization of ONE single-owner price proposal with the owner's hardware authenticator (WebAuthn). The steps:
 *  1. the server asks the DATABASE for a challenge and the summary of exactly what will be signed (kind, old and new value, version);
 *  2. the owner reads that summary (it comes from the database, not from this page) and confirms;
 *  3. the browser asks the authenticator to sign (user presence AND user verification required, the relying party id and origin are fixed by the database);
 *  4. the assertion goes back to the database, which verifies it inside Postgres and publishes, or answers with the reason it refused.
 * Nothing here decides anything: a wrong, replayed or tampered assertion is rejected by the database. Not usable from the session that made the proposal.
 */

const b64uToBuf = (s: string): ArrayBuffer => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const bufToB64u = (b: ArrayBuffer): string => {
  const u = new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const dollars = (c: number | null) => (c === null ? "none" : `$${(c / 100).toFixed(2)}`);

export default function PriceAuthorize({ requestId }: { requestId: string }) {
  const [challenge, setChallenge] = useState<AuthzChallenge | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await priceAuthzBegin(requestId);
      if (!r.ok) setMessage(r.message);
      else setChallenge(r.data);
    } catch {
      setMessage("Could not start the authorization. Nothing changed.");
    }
    setBusy(false);
  }

  async function sign() {
    if (!challenge) return;
    setBusy(true);
    setMessage(null);
    try {
      if (typeof navigator === "undefined" || !navigator.credentials) throw new Error("no WebAuthn");
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: b64uToBuf(challenge.challenge),
          rpId: challenge.rpId,
          allowCredentials: challenge.allowCredentials.map((id) => ({ type: "public-key" as const, id: b64uToBuf(id) })),
          userVerification: "required",
          timeout: challenge.expiresInSeconds * 1000,
        },
      })) as PublicKeyCredential | null;
      const resp = cred?.response as AuthenticatorAssertionResponse | undefined;
      if (!cred || !resp) throw new Error("cancelled");
      const r = await priceAuthzFinish({
        requestId, nonce: challenge.nonce, credentialId: bufToB64u(cred.rawId), authData: bufToB64u(resp.authenticatorData), clientData: bufToB64u(resp.clientDataJSON), signature: bufToB64u(resp.signature),
      });
      if (!r.ok) setMessage(r.message);
      else if (r.data.status === "applied") {
        setMessage("Authorized. The new price is published.");
        setChallenge(null);
      } else setMessage(`The database refused the signature: ${r.data.reason ?? "unknown reason"}. Nothing changed.`);
    } catch {
      setMessage("The authenticator did not sign (cancelled, not available or not allowed). Nothing changed.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2">
      {!challenge ? (
        <button type="button" onClick={start} disabled={busy} className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
          Authorize with my hardware key
        </button>
      ) : (
        <div className="space-y-2 text-sm text-slate-900">
          <p className="font-semibold">You are about to sign exactly this change (read from the database):</p>
          <ul className="list-disc pl-5 text-xs">
            <li>Scope: {challenge.summary.scope}; price: {challenge.summary.kind}; proposal version {challenge.summary.proposalVersion}</li>
            <li>Customer price: {dollars(challenge.summary.oldCustomerCents)} to <strong>{dollars(challenge.summary.newCustomerCents)}</strong></li>
            <li>DanceFlow provider cost: {dollars(challenge.summary.oldProviderCents)} to <strong>{dollars(challenge.summary.newProviderCents)}</strong></li>
            <li>Description: {challenge.summary.description}</li>
            <li>Fingerprint: {challenge.summary.hash.slice(0, 16)}</li>
          </ul>
          <button type="button" onClick={sign} disabled={busy} className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60">
            Sign with the hardware key
          </button>
        </div>
      )}
      {message ? <p role="status" className="text-xs text-slate-800">{message}</p> : null}
    </div>
  );
}
