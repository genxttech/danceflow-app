"use client";

import { useState } from "react";
import { b64uToBytes, keyRefusal, parseAuthDataFlags, spkiToXY, toHex } from "@/lib/sms/keySetup";

/**
 * Two small tools, run on the real site so the keys are bound to its relying party id (this host). Nothing is sent anywhere and nothing is stored: the results are shown
 * on screen for you to give to engineering. Only PUBLIC values appear. A private key never leaves the authenticator.
 */

type Created = { label: string; credIdHex: string; xHex: string; yHex: string; flagsText: string; refusal: string | null };
type Signed = { credIdHex: string; authHex: string; clientHex: string; sigHex: string };

const box = "rounded-xl border border-slate-200 bg-white p-4 space-y-2";
const btn = "rounded-lg bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60";
const input = "mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm";
const mono = "break-all rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-900";

export default function KeySetup() {
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<Created[]>([]);
  const [challenge, setChallenge] = useState("");
  const [credId, setCredId] = useState("");
  const [signed, setSigned] = useState<Signed | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const host = typeof window === "undefined" ? "" : window.location.hostname;

  async function createKey() {
    setBusy(true);
    setMessage(null);
    try {
      if (!navigator.credentials) throw new Error("no WebAuthn");
      const name = label.trim() || "price key";
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: "DanceFlow", id: host },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { authenticatorAttachment: "cross-platform", userVerification: "required", residentKey: "discouraged" },
          attestation: "none",
          timeout: 120000,
        },
      })) as PublicKeyCredential | null;
      const resp = cred?.response as AuthenticatorAttestationResponse | undefined;
      const spki = resp?.getPublicKey?.();
      const authData = resp?.getAuthenticatorData?.();
      if (!cred || !spki || !authData) throw new Error("no key");
      const { x, y } = spkiToXY(new Uint8Array(spki));
      const flags = parseAuthDataFlags(new Uint8Array(authData));
      setCreated((c) => [
        ...c,
        {
          label: name,
          credIdHex: toHex(new Uint8Array(cred.rawId)),
          xHex: toHex(x),
          yHex: toHex(y),
          flagsText: `user present: ${flags.userPresent ? "yes" : "no"}, user verified: ${flags.userVerified ? "yes" : "no"}, backup eligible: ${flags.backupEligible ? "yes" : "no"}, backed up: ${flags.backedUp ? "yes" : "no"}`,
          refusal: keyRefusal(flags),
        },
      ]);
      setMessage("Key created. Check that it says ACCEPTABLE before you give these values to engineering.");
    } catch {
      setMessage("The key was not created (cancelled, not allowed, or this browser cannot make a security key credential). Nothing changed.");
    }
    setBusy(false);
  }

  async function signChallenge() {
    setBusy(true);
    setMessage(null);
    setSigned(null);
    try {
      const idBytes = b64uToBytes(credId.trim());
      const got = (await navigator.credentials.get({
        publicKey: {
          challenge: b64uToBytes(challenge.trim()),
          rpId: host,
          allowCredentials: [{ type: "public-key", id: idBytes }],
          userVerification: "required",
          timeout: 120000,
        },
      })) as PublicKeyCredential | null;
      const r = got?.response as AuthenticatorAssertionResponse | undefined;
      if (!got || !r) throw new Error("cancelled");
      setSigned({ credIdHex: toHex(new Uint8Array(got.rawId)), authHex: toHex(new Uint8Array(r.authenticatorData)), clientHex: toHex(new Uint8Array(r.clientDataJSON)), sigHex: toHex(new Uint8Array(r.signature)) });
    } catch {
      setMessage("The challenge was not signed (cancelled, wrong key, or the values were not valid). Nothing changed.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        This page runs on <strong>{host || "this site"}</strong>; the keys you create here are bound to that host, which must be the relying party engineering configures. Nothing is sent or stored. Use a hardware
        security key (not a phone or a synced passkey). Create the primary key, then the offline recovery key (a separate key kept in a different place).
      </p>

      <section className={box}>
        <h2 className="text-sm font-semibold text-slate-900">1. Create a key and show its public values</h2>
        <label className="block text-xs text-slate-700">
          Label (for example: primary, recovery)
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className={input} />
        </label>
        <button type="button" className={btn} onClick={createKey} disabled={busy}>Create key</button>
        {created.map((k, i) => (
          <div key={i} className="space-y-1 border-t border-slate-100 pt-2">
            <p className="text-xs font-semibold text-slate-900">{k.label}: {k.refusal ? <span className="text-red-700">NOT ACCEPTABLE. {k.refusal}</span> : <span className="text-emerald-700">ACCEPTABLE</span>}</p>
            <p className="text-xs text-slate-600">{k.flagsText}</p>
            <p className="text-xs text-slate-600">credential id (hex)</p><p className={mono}>{k.credIdHex}</p>
            <p className="text-xs text-slate-600">public key x (hex)</p><p className={mono}>{k.xHex}</p>
            <p className="text-xs text-slate-600">public key y (hex)</p><p className={mono}>{k.yHex}</p>
          </div>
        ))}
      </section>

      <section className={box}>
        <h2 className="text-sm font-semibold text-slate-900">2. Sign a challenge engineering gives you (proves the key works)</h2>
        <label className="block text-xs text-slate-700">
          Credential id (base64url, as engineering gives it)
          <input value={credId} onChange={(e) => setCredId(e.target.value)} className={input} />
        </label>
        <label className="block text-xs text-slate-700">
          Challenge (base64url, as engineering gives it)
          <input value={challenge} onChange={(e) => setChallenge(e.target.value)} className={input} />
        </label>
        <button type="button" className={btn} onClick={signChallenge} disabled={busy || !credId.trim() || !challenge.trim()}>Sign with the key</button>
        {signed ? (
          <div className="space-y-1 border-t border-slate-100 pt-2">
            <p className="text-xs text-slate-600">authenticator data (hex)</p><p className={mono}>{signed.authHex}</p>
            <p className="text-xs text-slate-600">client data (hex)</p><p className={mono}>{signed.clientHex}</p>
            <p className="text-xs text-slate-600">signature (hex)</p><p className={mono}>{signed.sigHex}</p>
          </div>
        ) : null}
      </section>

      {message ? <p role="status" className="text-sm text-slate-800">{message}</p> : null}
    </div>
  );
}
