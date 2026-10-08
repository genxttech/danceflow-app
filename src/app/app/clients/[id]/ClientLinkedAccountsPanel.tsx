import { ChevronDown } from "lucide-react";
import { RELATIONSHIP_LABELS, type ClientRelationshipLink } from "@/lib/student-identity/relationship-links";
import { sendPortalInviteAction, updateDocumentSigningPermissionAction } from "./actions";

/**
 * Phase 8D: who can act for this client, and who may sign documents for them. Signing permission for a non-self
 * relationship is an explicit staff decision (never implied by the relationship type); the client's own account
 * always signs for itself.
 */
export default function ClientLinkedAccountsPanel({
  clientId,
  links,
  canManageSigning,
}: {
  clientId: string;
  links: ClientRelationshipLink[];
  canManageSigning: boolean;
}) {
  return (
    <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <h3 className="text-lg font-semibold text-[var(--brand-text)]">People who can act for this client</h3>
      <p className="mt-1 text-sm leading-6 text-[var(--brand-muted)]">
        Parents, guardians and contacts linked to this client. Only people allowed to sign documents can receive and
        sign document requests for this client.
      </p>

      <div className="mt-4 space-y-3">
        {links.length ? (
          links.map((link) => {
            const isSelf = link.relationshipType === "self";
            return (
              <div key={link.id} className="flex flex-col gap-3 rounded-2xl border border-[var(--brand-border)] p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-[var(--brand-text)]">
                    {RELATIONSHIP_LABELS[link.relationshipType] ?? link.relationshipType}
                    {link.status !== "linked" ? <span className="ml-2 text-xs font-medium text-[var(--brand-muted)]">(invitation pending)</span> : null}
                  </p>
                  <p className="text-sm text-[var(--brand-muted)]">{link.email ?? "No email on file"}</p>
                  <p className={`mt-1 text-xs font-semibold ${link.canSignDocuments ? "text-emerald-700" : "text-slate-500"}`}>
                    {isSelf
                      ? "Signs documents for themself"
                      : link.canSignDocuments
                        ? "Can sign documents for this client"
                        : "Cannot sign documents for this client"}
                  </p>
                </div>
                {!isSelf && canManageSigning ? (
                  <form action={updateDocumentSigningPermissionAction}>
                    <input type="hidden" name="clientId" value={clientId} />
                    <input type="hidden" name="linkId" value={link.id} />
                    <input type="hidden" name="allow" value={link.canSignDocuments ? "false" : "true"} />
                    <button
                      type="submit"
                      className={`rounded-xl px-3 py-2 text-xs font-semibold ${
                        link.canSignDocuments
                          ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          : "bg-[var(--brand-primary)] text-white hover:opacity-95"
                      }`}
                    >
                      {link.canSignDocuments ? "Remove signing permission" : "Allow to sign documents"}
                    </button>
                  </form>
                ) : null}
              </div>
            );
          })
        ) : (
          <p className="rounded-2xl border border-dashed border-[var(--brand-border)] p-4 text-sm text-[var(--brand-muted)]">
            No one is linked to this client yet.
          </p>
        )}
      </div>

      <details className="group mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-[var(--brand-text)]">
          Invite a parent, guardian or contact
          <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <form action={sendPortalInviteAction} className="mt-4 grid gap-3">
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="returnTo" value={`/app/clients/${clientId}?tab=portal`} />
          <label className="text-sm font-medium text-[var(--brand-text)]">
            Relationship
            <select name="relationshipType" defaultValue="guardian" className="mt-1 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm">
              <option value="guardian">Guardian</option>
              <option value="parent">Parent</option>
              <option value="billing_contact">Billing contact</option>
              <option value="dependent_manager">Dependent manager</option>
            </select>
          </label>
          <label className="text-sm font-medium text-[var(--brand-text)]">
            Their email
            <input name="inviteEmail" type="email" required className="mt-1 w-full rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm" />
          </label>
          {canManageSigning ? (
            <label className="flex items-start gap-2 text-sm text-[var(--brand-text)]">
              <input type="checkbox" name="grantDocumentSigning" className="mt-1" />
              <span>Can sign documents for this client</span>
            </label>
          ) : null}
          <button type="submit" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white hover:opacity-95">
            Send invitation
          </button>
        </form>
      </details>
    </section>
  );
}
