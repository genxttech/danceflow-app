"use client";

import { useEffect, useRef, useState } from "react";
import { ticketKindMayCreateLeads } from "@/lib/events/leadEligibility";

/**
 * G-02 (Rule 1): per-ticket-type "add buyers to Leads" setting, default OFF. Rendered only while the form's ticket kind is
 * one that may be flagged (general admission). The hidden marker tells updateTicketTypeAction that this form shows the
 * control, so an unchecked box really means "off" (other forms that omit the control never change the stored value).
 */
export default function ProspectLeadToggle({
  initialKind,
  defaultChecked = false,
  disabled = false,
}: {
  initialKind: string;
  defaultChecked?: boolean;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState(initialKind);
  const anchor = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const select = anchor.current?.closest("form")?.querySelector<HTMLSelectElement>('select[name="ticketKind"]');
    if (!select) return;
    const sync = () => setKind(select.value);
    sync();
    select.addEventListener("change", sync);
    return () => select.removeEventListener("change", sync);
  }, []);

  const flaggable = ticketKindMayCreateLeads(kind);

  return (
    <div ref={anchor} className="md:col-span-2">
      {flaggable ? (
        <>
          <input type="hidden" name="createsProspectLeadPresent" value="1" />
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              name="createsProspectLead"
              defaultChecked={defaultChecked}
              disabled={disabled}
              className="mt-1"
            />
            <span>
              <span className="font-medium text-slate-700">Add buyers of this ticket to Leads</span>
              <span className="block text-slate-500">
                When checked, people who pay for this ticket are added to your Leads as prospective students. Leave it
                unchecked for tickets bought by spectators, guests or people who are not prospects; you will still get a
                notification for every registration.
              </span>
            </span>
          </label>
        </>
      ) : null}
    </div>
  );
}
