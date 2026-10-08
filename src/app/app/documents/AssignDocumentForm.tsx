"use client";

import { useEffect, useId, useRef, useState } from "react";
import { assignDocumentToClientAction } from "./actions";
import {
  loadRecipientOptionsAction,
  searchAssignableClientsAction,
  type AssignableClient,
  type RecipientOptions,
} from "./assign-actions";

/**
 * Phase 8D -- the ONE assignment form, used from a template card (template fixed, choose the client) and from a
 * client profile (client preselected, choose the template). Searchable client picker (server-side search, never the
 * whole roster) and an explicit recipient choice: the client by default; an authorized linked signer when the client
 * has no email or staff choose one deliberately. "Prepare document" creates a draft for review -- sending is a
 * separate step after the signing fields are checked.
 */
export default function AssignDocumentForm({
  templateId,
  templates,
  initialClient = null,
  assignContext,
}: {
  templateId?: string;
  templates?: Array<{ id: string; title: string }>;
  initialClient?: AssignableClient | null;
  assignContext?: "client";
}) {
  const listId = useId();
  const [client, setClient] = useState<AssignableClient | null>(initialClient);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssignableClient[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [options, setOptions] = useState<RecipientOptions | null>(null);
  const [recipient, setRecipient] = useState<string>("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyOptions(next: RecipientOptions | null) {
    setOptions(next);
    if (!next) return setRecipient("");
    if (next.clientEmail) return setRecipient("client");
    if (next.signers.length === 1) return setRecipient(next.signers[0].linkId);
    setRecipient("");
  }

  useEffect(() => {
    if (!initialClient) return;
    let cancelled = false;
    loadRecipientOptionsAction(initialClient.id).then((next) => {
      if (!cancelled) applyOptions(next);
    });
    return () => {
      cancelled = true;
    };
  }, [initialClient]);

  function onSearch(value: string) {
    setQuery(value);
    setOpen(true);
    setActive(0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      searchAssignableClientsAction(value).then(setResults);
    }, 200);
  }

  function choose(next: AssignableClient) {
    setClient(next);
    setOpen(false);
    setQuery("");
    setResults([]);
    setOptions(null);
    loadRecipientOptionsAction(next.id).then(applyOptions);
  }

  const blocked = Boolean(options && !options.clientEmail && options.signers.length === 0);
  const needsChoice = Boolean(options && !options.clientEmail && options.signers.length > 1 && !recipient);

  return (
    <form action={assignDocumentToClientAction} className="mt-4 grid gap-3">
      <input type="hidden" name="scope" value="studio" />
      {templateId ? <input type="hidden" name="templateId" value={templateId} /> : null}
      {assignContext ? <input type="hidden" name="assignContext" value={assignContext} /> : null}
      <input type="hidden" name="clientId" value={client?.id ?? ""} />
      <input type="hidden" name="recipient" value={recipient} />

      {templates ? (
        <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
          Document
          <select name="templateId" required defaultValue="" className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm">
            <option value="" disabled>
              Choose a document
            </option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
        <span>Client</span>
        {client ? (
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3">
            <span className="min-w-0 truncate font-medium">
              {client.name}
              {client.email ? <span className="ml-2 font-normal text-[var(--brand-muted)]">{client.email}</span> : null}
            </span>
            {!initialClient ? (
              <button type="button" onClick={() => { setClient(null); setOptions(null); setRecipient(""); }} className="text-xs font-semibold text-[var(--brand-primary)]">
                Change
              </button>
            ) : null}
          </div>
        ) : (
          <div className="relative">
            <input
              role="combobox"
              aria-expanded={open && results.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-label="Search clients by name or email"
              value={query}
              placeholder="Search clients by name or email"
              onChange={(event) => onSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, results.length - 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); }
                if (event.key === "Enter" && open && results[active]) { event.preventDefault(); choose(results[active]); }
                if (event.key === "Escape") setOpen(false);
              }}
              className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm font-normal"
            />
            {open && results.length ? (
              <ul id={listId} role="listbox" className="absolute z-20 mt-1 w-full overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-white shadow-lg">
                {results.map((result, index) => (
                  <li
                    key={result.id}
                    role="option"
                    aria-selected={index === active}
                    onMouseDown={(event) => { event.preventDefault(); choose(result); }}
                    className={`cursor-pointer px-4 py-2 text-sm font-normal ${index === active ? "bg-[var(--brand-primary-soft)]" : ""}`}
                  >
                    <span className="font-medium">{result.name}</span>
                    {result.email ? <span className="ml-2 text-[var(--brand-muted)]">{result.email}</span> : <span className="ml-2 text-[var(--brand-muted)]">No email</span>}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </div>

      {client && options ? (
        <fieldset className="space-y-2 text-sm text-[var(--brand-text)]">
          <legend className="font-semibold">Send to</legend>
          {blocked ? (
            <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-amber-900">
              This client has no email address and no one linked to them is allowed to sign documents. Add the
              client&apos;s email, or link a parent or guardian on the client&apos;s Portal tab and allow them to sign.
            </p>
          ) : (
            <>
              {options.clientEmail ? (
                <label className="flex items-center gap-2">
                  <input type="radio" name="recipientChoice" checked={recipient === "client"} onChange={() => setRecipient("client")} />
                  The client ({options.clientEmail})
                </label>
              ) : (
                <p className="text-[var(--brand-muted)]">This client has no email, so the request goes to an authorized signer on their behalf.</p>
              )}
              {options.signers.map((signer) => (
                <label key={signer.linkId} className="flex items-center gap-2">
                  <input type="radio" name="recipientChoice" checked={recipient === signer.linkId} onChange={() => setRecipient(signer.linkId)} />
                  {signer.label} - {signer.email}
                </label>
              ))}
            </>
          )}
        </fieldset>
      ) : null}

      <label className="space-y-2 text-sm font-semibold text-[var(--brand-text)]">
        Due date (optional)
        <input name="dueDate" type="date" className="w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm" />
      </label>

      <button
        type="submit"
        disabled={!client || !options || blocked || needsChoice}
        className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Prepare document
      </button>
      <p className="text-xs text-[var(--brand-muted)]">You will review the signing fields before anything is sent.</p>
    </form>
  );
}
