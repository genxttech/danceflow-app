import { DOCUMENT_REF_MAX, EVIDENCE_MAX_AGE_DAYS, EVIDENCE_ROLES, EVIDENCE_ROLE_LABEL, SCOPE_LABEL, type EvidenceScope } from "@/lib/sms/pilotApprovalEvidence";

/**
 * U-4: the owner's dated written authorization of a PILOT spend, as structured evidence (hash and reference only). Shared by the pilot exception form and the pilot fee-approval
 * forms. A reference alone is not authorization. Nothing here asks for the text of the authorization, and nothing typed is ever echoed back. The amount is the amount of the
 * form it sits in (the published price, or the ceiling being created): it is not collected twice.
 */
export default function PilotEvidenceFields({ scopes, inputClass, required = true }: { scopes: readonly EvidenceScope[]; inputClass: string; required?: boolean }) {
  const labelClass = "text-xs font-medium text-slate-800";
  return (
    <div className="grid gap-2 rounded-lg border border-fuchsia-100 p-2">
      <p className="text-xs text-slate-600">
        The reference alone is not authorization. Record the owner&apos;s dated written authorization: DanceFlow stores only the date, who authorized it, what it covers, the document id or link
        and the sha256 of the retained file. The text itself is never entered here and never stored.
      </p>
      <label className={labelClass}>
        Date of the written authorization (not in the future, not older than {EVIDENCE_MAX_AGE_DAYS} days)
        <input type="date" name="authorizedOn" required={required} className={inputClass} />
      </label>
      <label className={labelClass}>
        Authorized by (as stated in the written authorization)
        <select name="authorizedByRole" required={required} defaultValue="" className={inputClass}>
          <option value="" disabled>Choose who authorized</option>
          {EVIDENCE_ROLES.map((role) => <option key={role} value={role}>{EVIDENCE_ROLE_LABEL[role]}</option>)}
        </select>
      </label>
      <label className={labelClass}>
        What it covers
        <select name="scope" required={required} defaultValue={scopes.length === 1 ? scopes[0] : ""} className={inputClass}>
          {scopes.length === 1 ? null : <option value="" disabled>Choose what it covers</option>}
          {scopes.map((scope) => <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>)}
        </select>
      </label>
      <label className={labelClass}>
        Retained document: an id or a plain https link (no query string, fragment, credentials, or any of ; &amp; = %)
        <input name="documentRef" required={required} minLength={6} maxLength={DOCUMENT_REF_MAX} autoComplete="off" className={inputClass} />
      </label>
      <p className="text-xs text-slate-600">This reference is stored permanently. It must not be a share or access link, and must not contain a person&apos;s name. Prefer an internal document id.</p>
      <label className={labelClass}>
        sha256 of the retained authorization: the SHA-256 of the exact bytes of the retained file, as 64 hex characters (upper case is accepted and stored in lower case)
        <input name="documentSha256" required={required} minLength={64} maxLength={64} pattern="[0-9a-fA-F]{64}" autoComplete="off" className={inputClass} />
      </label>
    </div>
  );
}
