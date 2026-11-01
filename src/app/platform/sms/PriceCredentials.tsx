"use client";

import { useEffect, useState } from "react";
import { priceCredApply, priceCredBegin, priceCredCancel, priceCredEnroll, priceCredPending, priceCredRevoke, priceThaw } from "./priceChangeActions";
import type { CredChallenge, CredentialState } from "@/lib/sms/priceChange";

/**
 * Hardware-key management for the pricing owner. Every change here is a REQUEST the database delays (enrol and revoke take effect only after the configured
 * delay, and can be cancelled while pending); this page only collects the signatures. The database decides and answers; nothing is trusted from the browser.
 */

const b64uToBuf = (s: string): ArrayBuffer => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const bufToB64u = (b: ArrayBuffer | Uint8Array): string => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

type Signed = { credentialId: string; auth: string; client: string; sig: string };

async function sign(c: CredChallenge, only?: string[]): Promise<Signed> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBuf(c.challenge),
      rpId: c.rpId,
      allowCredentials: (only ?? c.allowCredentials).map((id) => ({ type: "public-key" as const, id: b64uToBuf(id) })),
      userVerification: "required",
      timeout: 120000,
    },
  })) as PublicKeyCredential | null;
  const r = cred?.response as AuthenticatorAssertionResponse | undefined;
  if (!cred || !r) throw new Error("cancelled");
  return { credentialId: bufToB64u(cred.rawId), auth: bufToB64u(r.authenticatorData), client: bufToB64u(r.clientDataJSON), sig: bufToB64u(r.signature) };
}

export default function PriceCredentials() {
  const [state, setState] = useState<CredentialState | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<"primary" | "spare">("spare");

  async function load() {
    const r = await priceCredPending();
    if (r.ok) setState(r.data);
    else setMessage(r.message);
  }
  useEffect(() => {
    let live = true;
    void priceCredPending().then((r) => {
      if (!live) return;
      if (r.ok) setState(r.data);
      else setMessage(r.message);
    });
    return () => {
      live = false;
    };
  }, []);

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await fn());
    } catch {
      setMessage("The authenticator did not sign or the request failed. Nothing changed.");
    }
    await load();
    setBusy(false);
  }

  const enroll = () =>
    run(async () => {
      const created = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: "DanceFlow" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label || "price key", displayName: label || "price key" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { userVerification: "required", residentKey: "discouraged" },
          attestation: "none",
        },
      })) as PublicKeyCredential | null;
      const resp = created?.response as AuthenticatorAttestationResponse | undefined;
      const spki = resp?.getPublicKey?.();
      if (!created || !spki) throw new Error("no key");
      const raw = new Uint8Array(spki).slice(-65); // 0x04 || x || y for P-256
      const x = bufToB64u(raw.slice(1, 33));
      const y = bufToB64u(raw.slice(33, 65));
      const newId = bufToB64u(created.rawId);
      const b = await priceCredBegin({ purpose: "enroll", credentialId: newId, x, y, role, label });
      if (!b.ok) return b.message;
      const by = await sign(b.data);
      const mine = await sign(b.data, [newId]); // the new key proves it can sign this very challenge
      const r = await priceCredEnroll({
        nonce: b.data.nonce, newCredentialId: newId, x, y, role, label,
        byCredentialId: by.credentialId, byAuth: by.auth, byClient: by.client, bySig: by.sig, newAuth: mine.auth, newClient: mine.client, newSig: mine.sig,
      });
      if (!r.ok) return r.message;
      return r.data.status === "pending" ? "Requested. The new key becomes usable only after the delay; you can cancel it until then." : `The database refused: ${r.data.reason ?? "unknown reason"}. Nothing changed.`;
    });

  const revoke = (target: string) =>
    run(async () => {
      const b = await priceCredBegin({ purpose: "revoke", credentialId: target });
      if (!b.ok) return b.message;
      const by = await sign(b.data);
      const r = await priceCredRevoke({ nonce: b.data.nonce, target, byCredentialId: by.credentialId, byAuth: by.auth, byClient: by.client, bySig: by.sig });
      if (!r.ok) return r.message;
      return r.data.status === "pending" ? "Revocation requested. It takes effect after the delay and can be cancelled until then." : `The database refused: ${r.data.reason ?? "unknown reason"}. Nothing changed.`;
    });

  const thaw = () =>
    run(async () => {
      const b = await priceCredBegin({ purpose: "thaw" });
      if (!b.ok) return b.message;
      const s = await sign(b.data);
      const r = await priceThaw({ nonce: b.data.nonce, credentialId: s.credentialId, authData: s.auth, clientData: s.client, signature: s.sig });
      if (!r.ok) return r.message;
      return r.data.status === "thawed" ? "Publication resumed." : `The database refused: ${r.data.reason ?? "unknown reason"}. Nothing changed.`;
    });

  const act = (fn: (id: string) => ReturnType<typeof priceCredApply>, id: string) =>
    run(async () => {
      const r = await fn(id);
      return r.ok ? `Done: ${r.data.status ?? "ok"}.` : r.message;
    });

  return (
    <section className="space-y-3 rounded-xl border border-violet-200 bg-white px-3 py-3 text-sm text-slate-900" aria-label="Hardware keys for price authorization">
      <h3 className="font-semibold">Hardware keys</h3>
      <p className="text-xs">Adding or removing a key is a request. It takes effect only after the delay set in the database and can be cancelled until then. Synced passkeys are refused.</p>
      <ul className="space-y-1 text-xs">
        {state?.credentials.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
            <span>{c.label} ({c.role})</span>
            <button type="button" disabled={busy} onClick={() => revoke(c.id)} className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-60">Request removal</button>
          </li>
        ))}
        {state?.pending.map((p) => (
          <li key={p.changeId} className="flex items-center justify-between gap-2 text-amber-900">
            <span>Pending {p.kind}{p.label ? `: ${p.label}` : ""}, effective {p.effectiveAt ?? "later"}</span>
            <span className="flex gap-1">
              <button type="button" disabled={busy} onClick={() => act(priceCredApply, p.changeId)} className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-60">Apply</button>
              <button type="button" disabled={busy} onClick={() => act(priceCredCancel, p.changeId)} className="rounded border border-slate-300 px-2 py-0.5 disabled:opacity-60">Cancel</button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">Label<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="rounded border border-slate-300 px-2 py-1" /></label>
        <label className="flex flex-col gap-1">Role
          <select value={role} onChange={(e) => setRole(e.target.value === "primary" ? "primary" : "spare")} className="rounded border border-slate-300 px-2 py-1">
            <option value="spare">spare</option>
            <option value="primary">primary</option>
          </select>
        </label>
        <button type="button" disabled={busy || label.trim().length < 3} onClick={enroll} className="rounded-lg bg-violet-700 px-3 py-1.5 font-semibold text-white disabled:opacity-60">Request a new key</button>
        <button type="button" disabled={busy} onClick={thaw} className="rounded-lg border border-violet-700 px-3 py-1.5 font-semibold text-violet-800 disabled:opacity-60">Lift suspension</button>
      </div>
      {message ? <p role="status" className="text-xs">{message}</p> : null}
    </section>
  );
}
