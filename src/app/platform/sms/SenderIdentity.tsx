import type { SenderOverviewRow } from "@/lib/sms/senderVerification";
import { recordSenderAction, revokeSenderAction, verifySenderAction } from "./senderActions";

/**
 * TW-4F sender readiness, per linked studio: the business's own sending identity (Messaging Service, campaign, number), its status, the last
 * verification and whether the location can send billed texts right now. Read-only except for the three forms; verification reads Twilio on the server.
 */

const input = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";
const primary = "rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800";
const secondary = "rounded-xl border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50";

const STATUS_LABEL: Record<string, string> = { pending: "Pending verification", approved: "Approved", revoked: "Revoked", released: "Released" };
const SOURCE_LABEL: Record<string, string> = { provider_read: "Twilio reads", fake: "Local test data", callback: "Delivery report" };

export default function SenderIdentity({ studioId, row }: { studioId: string; row: SenderOverviewRow | null }) {
  const live = row && row.senderId && row.status !== "released" ? row : null;
  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid="sender-identity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-900">Sending identity</p>
        <span
          data-testid="sender-ready"
          className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${row?.ready ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}
        >
          {row?.ready ? "Ready: yes" : "Ready: no"}
        </span>
      </div>
      {row && row.senderId ? (
        <dl className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
          <div><dt className="text-slate-500">Status</dt><dd data-testid="sender-status">{STATUS_LABEL[row.status ?? ""] ?? row.status}</dd></div>
          <div><dt className="text-slate-500">Number</dt><dd>{row.senderE164}</dd></div>
          <div><dt className="text-slate-500">Messaging Service</dt><dd className="break-all">{row.messagingServiceSid}</dd></div>
          <div><dt className="text-slate-500">Campaign</dt><dd className="break-all">{row.campaignSid ?? "not recorded"}</dd></div>
          <div><dt className="text-slate-500">Phone number SID</dt><dd className="break-all">{row.phoneNumberSid ?? "not recorded"}</dd></div>
          <div>
            <dt className="text-slate-500">Last verification</dt>
            <dd data-testid="sender-verification">
              {row.verificationOutcome
                ? `${row.verificationOutcome}${row.verificationCode ? ` (${row.verificationCode})` : ""}, ${row.verifiedAt ? new Date(row.verifiedAt).toISOString().slice(0, 16).replace("T", " ") + " UTC" : ""}, ${SOURCE_LABEL[row.verificationSource ?? ""] ?? row.verificationSource}`
                : "never verified"}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-xs text-slate-600">No sender is recorded for this location. It cannot send billed texts.</p>
      )}

      {live && (live.status === "pending" || live.status === "approved") ? (
        <form action={verifySenderAction} className="mt-3 grid gap-2">
          <input type="hidden" name="studioId" value={studioId} />
          <input type="hidden" name="senderId" value={live.senderId ?? ""} />
          <label className="flex items-center gap-2 text-xs text-slate-800">
            <input type="checkbox" name="attestedOptOut" /> I checked in the Twilio Console that Advanced Opt-Out is on for this Messaging Service
          </label>
          <button type="submit" className={`${primary} w-fit`}>{live.status === "approved" ? "Verify again" : "Verify sender"}</button>
        </form>
      ) : null}

      {!live || live.status === "revoked" ? (
        <form action={recordSenderAction} className="mt-3 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="studioId" value={studioId} />
          <label className="text-xs font-medium text-slate-800">Messaging Service SID<input name="messagingServiceSid" required pattern="MG[0-9a-fA-F]{32}" className={input} /></label>
          <label className="text-xs font-medium text-slate-800">Campaign SID<input name="campaignSid" required pattern="QE[0-9a-fA-F]{32}" className={input} /></label>
          <label className="text-xs font-medium text-slate-800">Phone number SID<input name="phoneNumberSid" required pattern="PN[0-9a-fA-F]{32}" className={input} /></label>
          <label className="text-xs font-medium text-slate-800">Number (+1...)<input name="senderE164" required className={input} /></label>
          <label className="text-xs font-medium text-slate-800 sm:col-span-2">Why this sender (10+ characters)<input name="reason" required minLength={10} maxLength={300} className={input} /></label>
          <button type="submit" className={`${primary} w-fit`}>Record sender</button>
        </form>
      ) : null}

      {row && row.senderId && row.status !== "released" && row.status !== "revoked" ? (
        <form action={revokeSenderAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <input type="hidden" name="studioId" value={studioId} />
          <label className="text-xs font-medium text-slate-800">Reason to stop this sender (10+ characters)<input name="reason" required minLength={10} maxLength={300} className={input} /></label>
          <label className="flex items-center gap-2 pb-2 text-xs text-slate-800"><input type="checkbox" name="release" /> Also release its identifiers</label>
          <button type="submit" className={secondary}>Revoke sender</button>
        </form>
      ) : null}
      {row && row.status === "revoked" ? (
        <form action={revokeSenderAction} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <input type="hidden" name="studioId" value={studioId} />
          <input type="hidden" name="release" value="on" />
          <label className="text-xs font-medium text-slate-800">Reason to release its identifiers (10+ characters)<input name="reason" required minLength={10} maxLength={300} className={input} /></label>
          <button type="submit" className={secondary}>Release identifiers</button>
        </form>
      ) : null}
    </div>
  );
}
