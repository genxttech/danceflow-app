"use client";

import { useEffect, useRef, useState } from "react";
import {
  searchBookableClientsForInstructorAction,
  type BookableClientSearchResult,
} from "./actions";

// FC-1B5D: shared minimal booking-discovery search field for instructor
// mode, used by both the create and edit appointment forms. Debounced,
// server-searched (search_bookable_clients_for_instructor), never a
// preloaded roster. Selecting a result only fills in the form's clientId
// field for this appointment -- it does not by itself grant
// teaching-client access (see get_teaching_clients_for_instructor for
// that, a structurally separate interface).
export default function InstructorClientSearchField({
  fieldName,
  clientId,
  selectedClientLabel,
  disabled,
  onSelect,
  onClear,
}: {
  fieldName: string;
  clientId: string;
  selectedClientLabel: string;
  disabled?: boolean;
  onSelect: (client: BookableClientSearchResult) => void;
  onClear: () => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<BookableClientSearchResult[]>([]);
  const [pending, setPending] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmedSearch = searchText.trim();
  const searchEligible = trimmedSearch.length >= 2;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!searchEligible) {
      return;
    }

    const timeout = setTimeout(() => {
      setPending(true);
      searchBookableClientsForInstructorAction(trimmedSearch)
        .then((data) => setResults(data))
        .catch(() => setResults([]))
        .finally(() => setPending(false));
    }, 300);
    debounceRef.current = timeout;

    return () => clearTimeout(timeout);
  }, [trimmedSearch, searchEligible]);

  const visibleResults = searchEligible ? results : [];
  const isPending = searchEligible && pending;

  return (
    <div className="relative">
      <input type="hidden" name={fieldName} value={clientId} />
      {clientId && selectedClientLabel ? (
        <div className="flex items-center justify-between rounded-xl border border-slate-300 bg-slate-50 px-3 py-3 text-sm">
          <span>{selectedClientLabel}</span>
          {!disabled ? (
            <button
              type="button"
              onClick={onClear}
              className="text-xs font-medium text-violet-700 hover:underline"
            >
              Change
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <input
            type="text"
            disabled={disabled}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder={
              disabled
                ? "Not needed for unavailable blocks"
                : "Type at least 2 characters to search clients"
            }
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm disabled:bg-slate-100 disabled:text-slate-400"
          />
          {isPending ? (
            <p className="mt-1 text-xs text-slate-500">Searching…</p>
          ) : null}
          {visibleResults.length > 0 ? (
            <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
              {visibleResults.map((client) => (
                <li key={client.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(client);
                      setSearchText("");
                      setResults([]);
                    }}
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                  >
                    {client.first_name} {client.last_name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
