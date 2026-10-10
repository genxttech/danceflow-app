"use client";

import { useEffect, useMemo, useState } from "react";
import { buildEntryParticipants, defaultLeadChoice, leadChoicesFor, participantSlotsFor } from "@/lib/competition/participantRoles";
import {
  calculateCompetitionRegistrationQuote,
  type CompetitionDraftEntry,
  type CompetitionRegistrationCatalog,
  type CompetitionRegistrationDraft,
  type CompetitionRosterPerson,
} from "@/lib/competition/registrationPricing";

type RequiredDocument = { id: string; title: string; description: string | null; body: string; requiresSignature: boolean };

const inputClass = "h-10 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300";

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

// 10C.4: slots, lead/follow choices and the draft participant maps come from participantRoles.ts.
const participantSlots = participantSlotsFor;

export default function CompetitionRegistrationBuilder({
  eventSlug,
  catalog,
  currentUserEmail,
  signedIn,
  requiredDocuments,
}: {
  eventSlug: string;
  catalog: CompetitionRegistrationCatalog;
  currentUserEmail: string;
  signedIn: boolean;
  requiredDocuments: RequiredDocument[];
}) {
  const [registrationMode, setRegistrationMode] = useState<"individual" | "studio">("individual");
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState(currentUserEmail);
  const [buyerPhone, setBuyerPhone] = useState("");
  const [studioName, setStudioName] = useState("");
  const [people, setPeople] = useState<CompetitionRosterPerson[]>([]);
  const [entries, setEntries] = useState<CompetitionDraftEntry[]>([]);
  const [personFirstName, setPersonFirstName] = useState("");
  const [personLastName, setPersonLastName] = useState("");
  const [personType, setPersonType] = useState("dancer");
  const [personEmail, setPersonEmail] = useState("");
  const [personDateOfBirth, setPersonDateOfBirth] = useState("");
  const [personWsdcId, setPersonWsdcId] = useState("");
  const [personPrimaryRole, setPersonPrimaryRole] = useState<"leader" | "follower" | "">("");
  const [personIsSelf, setPersonIsSelf] = useState(false);
  const [programId, setProgramId] = useState(catalog.programs[0]?.id ?? "");
  const programContests = catalog.contests.filter((item) => item.program_id === programId);
  const [contestId, setContestId] = useState(programContests[0]?.id ?? "");
  const contest = catalog.contests.find((item) => item.id === contestId && item.program_id === programId) ?? null;
  const contestDivisions = catalog.divisions.filter((item) => item.contest_id === contestId);
  const [divisionId, setDivisionId] = useState(contestDivisions[0]?.id ?? "");
  const rule = catalog.rules.find((item) => item.contest_id === contestId) ?? null;
  const division = catalog.divisions.find((item) => item.id === divisionId && item.contest_id === contestId) ?? null;
  const offerings = catalog.offerings.filter((item) => item.division_id === divisionId);
  const [slotPeople, setSlotPeople] = useState<Record<string, string>>({});
  const [teamPeople, setTeamPeople] = useState<string[]>([]);
  const [selectedOfferingIds, setSelectedOfferingIds] = useState<string[]>([]);
  const [routineTitle, setRoutineTitle] = useState("");
  const [musicTitle, setMusicTitle] = useState("");
  const [musicArtist, setMusicArtist] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("");
  const [durationSeconds, setDurationSeconds] = useState("");
  const [randomPartnerRole, setRandomPartnerRole] = useState<"leader" | "follower">("leader");
  const [leadSlot, setLeadSlot] = useState(() => (contest ? defaultLeadChoice(contest.entry_format, contest.contest_type) : ""));
  const leadChoices = contest ? leadChoicesFor(contest.entry_format, contest.contest_type) : [];
  const [teamName, setTeamName] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [checkoutErrors, setCheckoutErrors] = useState<string[]>([]);
  // Idempotency: one request id per logical submission. A retry of the SAME draft reuses it (the
  // server replays the same order); any change to the draft starts a new registration request.
  const [clientRequestId, setClientRequestId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const hasWestCoastSwing = catalog.programs.some((program) => program.discipline_family === "west_coast_swing");

  const draft: CompetitionRegistrationDraft = useMemo(() => ({ registrationMode, buyerName, buyerEmail, buyerPhone, registeringStudioName: studioName, people, entries }), [registrationMode, buyerName, buyerEmail, buyerPhone, studioName, people, entries]);
  const quote = useMemo(() => calculateCompetitionRegistrationQuote(catalog, draft), [catalog, draft]);
  const draftKey = useMemo(() => JSON.stringify(draft), [draft]);
  useEffect(() => {
    setClientRequestId(newId());
  }, [draftKey]);
  const hasSelf = people.some((person) => person.isSelf);

  function resetEntrySelections(nextProgramId = programId, nextContestId?: string) {
    const nextContests = catalog.contests.filter((item) => item.program_id === nextProgramId);
    const resolvedContestId = nextContestId ?? nextContests[0]?.id ?? "";
    const resolvedDivisionId = catalog.divisions.find((item) => item.contest_id === resolvedContestId)?.id ?? "";
    setContestId(resolvedContestId);
    setDivisionId(resolvedDivisionId);
    setSlotPeople({});
    setTeamPeople([]);
    setSelectedOfferingIds([]);
    setRoutineTitle("");
    setMusicTitle("");
    setMusicArtist("");
    setDurationMinutes("");
    setDurationSeconds("");
    setRandomPartnerRole("leader");
    const nextContest = catalog.contests.find((item) => item.id === resolvedContestId);
    setLeadSlot(nextContest ? defaultLeadChoice(nextContest.entry_format, nextContest.contest_type) : "");
    setTeamName("");
  }

  function addPerson() {
    if (!personFirstName.trim() || !personLastName.trim()) return;
    setPeople((current) => [...current, { clientId: newId(), firstName: personFirstName.trim(), lastName: personLastName.trim(), email: personEmail.trim(), dateOfBirth: personDateOfBirth, personType, wsdcCompetitorId: personWsdcId.trim(), primaryRole: personPrimaryRole, ...(personIsSelf && signedIn && !hasSelf ? { isSelf: true } : {}) }]);
    setPersonIsSelf(false);
    setPersonFirstName("");
    setPersonLastName("");
    setPersonEmail("");
    setPersonDateOfBirth("");
    setPersonWsdcId("");
    setPersonPrimaryRole("");
  }

  function addEntry() {
    if (!contest || !division || !rule) return;
    const { participantIds, participantRoles, participantDanceRoles } = buildEntryParticipants({
      entryFormat: contest.entry_format, slotPeople, teamPeople, leadSlot, randomPartnerRole,
    });
    setEntries((current) => [...current, {
      clientId: newId(), programId, contestId, divisionId, participantIds, participantRoles, participantDanceRoles,
      selectedOfferingIds, routineTitle, musicTitle, musicArtist,
      ...(contest.entry_format === "team" ? { teamName: teamName.trim() } : {}),
      routineDurationSeconds: Math.max(0, Number(durationMinutes || 0) * 60 + Number(durationSeconds || 0)),
      notes: "",
    }]);
    setSlotPeople({});
    setTeamPeople([]);
    setSelectedOfferingIds([]);
    setRoutineTitle("");
    setMusicTitle("");
    setMusicArtist("");
    setDurationMinutes("");
    setDurationSeconds("");
    setRandomPartnerRole("leader");
    setTeamName("");
  }

  async function beginCheckout() {
    setCheckoutError("");
    setCheckoutErrors([]);
    if (!quote.valid || !clientRequestId) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventSlug)}/competition/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId, draft }),
      });
      const result = await response.json();
      if (!response.ok || !result.url) {
        if (["idempotency_conflict", "expired", "not_payable"].includes(result.code)) setClientRequestId(newId());
        setCheckoutErrors(Array.isArray(result.errors) ? result.errors : []);
        throw new Error(result.error || "Checkout could not be started.");
      }
      window.location.assign(result.url);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Checkout could not be started.");
      setSubmitting(false);
    }
  }

  return <div className="grid gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_340px]">
    <div className="space-y-8">
      <section className="border-b border-slate-200 pb-7"><h2 className="text-lg font-semibold text-slate-950">Registration contact</h2><div className="mt-4 flex gap-2"><button type="button" onClick={() => setRegistrationMode("individual")} className={`rounded border px-4 py-2 text-sm font-semibold ${registrationMode === "individual" ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 text-slate-700"}`}>Individual</button><button type="button" onClick={() => setRegistrationMode("studio")} className={`rounded border px-4 py-2 text-sm font-semibold ${registrationMode === "studio" ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 text-slate-700"}`}>Studio registration</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><input value={buyerName} onChange={(event) => setBuyerName(event.target.value)} placeholder="Contact name" className={inputClass} /><input type="email" value={buyerEmail} onChange={(event) => setBuyerEmail(event.target.value)} placeholder="Contact email" className={inputClass} /><input value={buyerPhone} onChange={(event) => setBuyerPhone(event.target.value)} placeholder="Contact phone" className={inputClass} />{registrationMode === "studio" ? <input value={studioName} onChange={(event) => setStudioName(event.target.value)} placeholder="Studio name" className={inputClass} /> : null}</div></section>

      <section className="border-b border-slate-200 pb-7"><div className="flex items-end justify-between gap-4"><div><h2 className="text-lg font-semibold text-slate-950">{registrationMode === "studio" ? "Studio roster" : "Participants"}</h2><p className="mt-1 text-sm text-slate-600">Add each dancer, student, professional, or instructor once, then reuse them across entries.</p></div><span className="text-sm font-semibold text-slate-600">{people.length}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3"><input value={personFirstName} onChange={(event) => setPersonFirstName(event.target.value)} placeholder="First name" className={inputClass} /><input value={personLastName} onChange={(event) => setPersonLastName(event.target.value)} placeholder="Last name" className={inputClass} /><input type="email" value={personEmail} onChange={(event) => setPersonEmail(event.target.value)} placeholder="Email, optional" className={inputClass} /><input type="date" value={personDateOfBirth} onChange={(event) => setPersonDateOfBirth(event.target.value)} className={inputClass} /><select value={personType} onChange={(event) => setPersonType(event.target.value)} className={inputClass}><option value="dancer">Dancer</option><option value="student">Student</option><option value="professional">Professional</option><option value="instructor">Instructor</option><option value="team_member">Team member</option></select>{hasWestCoastSwing ? <><input value={personWsdcId} onChange={(event) => setPersonWsdcId(event.target.value)} placeholder="WSDC Competitor ID, if assigned" className={inputClass} /><select value={personPrimaryRole} onChange={(event) => setPersonPrimaryRole(event.target.value as "leader" | "follower" | "")} className={inputClass}><option value="">Primary role, if known</option><option value="leader">Leader</option><option value="follower">Follower</option></select></> : null}{signedIn && !hasSelf ? <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={personIsSelf} onChange={(event) => setPersonIsSelf(event.target.checked)} />This is me (link to my DanceFlow account)</label> : null}<button type="button" onClick={addPerson} className={buttonClass}>Add to roster</button></div><div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{people.map((person) => <div key={person.clientId} className="flex items-center justify-between gap-4 py-3"><div><p className="text-sm font-semibold text-slate-900">{person.firstName} {person.lastName}{person.isSelf ? <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">You</span> : null}</p><p className="text-xs text-slate-500">{person.personType.replaceAll("_", " ")}{person.dateOfBirth ? ` · Born ${person.dateOfBirth}` : ""}{person.wsdcCompetitorId ? ` · WSDC ${person.wsdcCompetitorId}` : ""}{person.primaryRole ? ` · Primary ${person.primaryRole}` : ""}</p></div><button type="button" onClick={() => setPeople((current) => current.filter((item) => item.clientId !== person.clientId))} className="text-xs font-semibold text-rose-700">Remove</button></div>)}</div></section>

      <section className="border-b border-slate-200 pb-7"><h2 className="text-lg font-semibold text-slate-950">Add competition entry</h2><div className="mt-4 flex flex-wrap gap-2">{catalog.programs.map((program) => <button key={program.id} type="button" onClick={() => { setProgramId(program.id); resetEntrySelections(program.id); }} className={`rounded border px-4 py-2 text-sm font-semibold ${programId === program.id ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 text-slate-700"}`}>{program.name}</button>)}</div><div className="mt-4 grid gap-3 sm:grid-cols-2"><select value={contestId} onChange={(event) => resetEntrySelections(programId, event.target.value)} className={inputClass}>{programContests.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={divisionId} onChange={(event) => { setDivisionId(event.target.value); setSelectedOfferingIds([]); }} className={inputClass}>{contestDivisions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>{rule?.public_description ? <p className="mt-3 text-sm text-slate-600">{rule.public_description}</p> : null}

      {leadChoices.length > 0 ? <label className="mt-5 block max-w-sm text-sm font-semibold text-slate-800">Who leads?<select value={leadSlot} onChange={(event) => setLeadSlot(event.target.value)} className={`${inputClass} mt-1 w-full`}>{leadChoices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label> : null}
      {contest?.entry_format === "random_partner" ? <label className="mt-5 block max-w-sm text-sm font-semibold text-slate-800">Lead or follow<select value={randomPartnerRole} onChange={(event) => setRandomPartnerRole(event.target.value as "leader" | "follower")} className={`${inputClass} mt-1 w-full`}><option value="leader">Leader</option><option value="follower">Follower</option></select></label> : null}

      {contest?.entry_format === "team" ? <div className="mt-5"><label className="block max-w-sm text-sm font-semibold text-slate-800">Team name<input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Team name" className={`${inputClass} mt-1 w-full`} /></label><p className="mt-4 text-sm font-semibold text-slate-900">Team members</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{people.map((person) => <label key={person.clientId} className="flex items-center gap-2 border border-slate-200 px-3 py-2 text-sm"><input type="checkbox" checked={teamPeople.includes(person.clientId)} onChange={(event) => setTeamPeople((current) => event.target.checked ? [...current, person.clientId] : current.filter((id) => id !== person.clientId))} />{person.firstName} {person.lastName}</label>)}</div></div> : <div className="mt-5 grid gap-3 sm:grid-cols-2">{contest ? participantSlots(contest.entry_format).map((slot) => <label key={slot.key} className="text-sm font-semibold text-slate-800">{slot.label}<select value={slotPeople[slot.key] ?? ""} onChange={(event) => setSlotPeople((current) => ({ ...current, [slot.key]: event.target.value }))} className={`${inputClass} mt-1 w-full`}><option value="">Select participant</option>{people.map((person) => <option key={person.clientId} value={person.clientId}>{person.firstName} {person.lastName}</option>)}</select></label>) : null}</div>}

      {rule && ["individual", "choose_count"].includes(rule.dance_selection_mode) ? <div className="mt-5"><p className="text-sm font-semibold text-slate-900">{rule.terminology.dance_label ?? "Dances"}</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{offerings.map((offering) => <label key={offering.id} className="flex items-center justify-between gap-3 border border-slate-200 px-3 py-2 text-sm"><span className="flex items-center gap-2"><input type="checkbox" disabled={offering.required} checked={offering.required || selectedOfferingIds.includes(offering.id)} onChange={(event) => setSelectedOfferingIds((current) => event.target.checked ? [...current, offering.id] : current.filter((id) => id !== offering.id))} />{offering.dance?.name ?? "Dance"}{offering.required ? " · Required" : ""}</span><span className="text-slate-500">{money(offering.entry_fee, offering.currency)}</span></label>)}</div></div> : rule && ["prescribed_set", "routine"].includes(rule.dance_selection_mode) ? <div className="mt-5"><p className="text-sm font-semibold text-slate-900">Included {rule.terminology.dance_label?.toLowerCase() ?? "dances"}</p><p className="mt-1 text-sm text-slate-600">{offerings.map((offering) => offering.dance?.name).filter(Boolean).join(" · ")}</p></div> : null}

      {rule && (rule.requires_routine_title || rule.requires_music || rule.requires_duration) ? <div className="mt-5 grid gap-3 sm:grid-cols-2">{rule.requires_routine_title ? <input value={routineTitle} onChange={(event) => setRoutineTitle(event.target.value)} placeholder="Routine title" className={inputClass} /> : null}{rule.requires_music ? <><input value={musicTitle} onChange={(event) => setMusicTitle(event.target.value)} placeholder="Music title" className={inputClass} /><input value={musicArtist} onChange={(event) => setMusicArtist(event.target.value)} placeholder="Music artist" className={inputClass} /></> : null}{rule.requires_duration ? <div className="grid grid-cols-2 gap-2"><input value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} type="number" min="0" placeholder="Minutes" className={inputClass} /><input value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} type="number" min="0" max="59" placeholder="Seconds" className={inputClass} /></div> : null}</div> : null}
      <button type="button" onClick={addEntry} className={`${buttonClass} mt-5`}>Add entry</button></section>

      <section className="border-b border-slate-200 pb-7"><div className="flex items-end justify-between gap-4"><h2 className="text-lg font-semibold text-slate-950">Entries</h2><span className="text-sm font-semibold text-slate-600">{entries.length}</span></div><div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{entries.map((entry) => { const entryContest = catalog.contests.find((item) => item.id === entry.contestId); const entryDivision = catalog.divisions.find((item) => item.id === entry.divisionId); const names = entry.participantIds.map((id) => people.find((person) => person.clientId === id)).filter(Boolean).map((person) => `${person?.firstName} ${person?.lastName}`).join(" · "); return <div key={entry.clientId} className="flex items-start justify-between gap-4 py-4"><div><p className="text-sm font-semibold text-slate-900">{entryContest?.name} · {entryDivision?.name}</p><p className="mt-1 text-sm text-slate-600">{names || "Participants needed"}</p></div><button type="button" onClick={() => setEntries((current) => current.filter((item) => item.clientId !== entry.clientId))} className="text-xs font-semibold text-rose-700">Remove</button></div>; })}</div></section>

      {requiredDocuments.length > 0 ? <section className="pb-7"><h2 className="text-lg font-semibold text-slate-950">Required documents</h2><div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{requiredDocuments.map((document) => <details key={document.id} className="py-3"><summary className="cursor-pointer text-sm font-semibold text-slate-900">{document.title}</summary>{document.description ? <p className="mt-2 text-sm text-slate-600">{document.description}</p> : null}<div className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{document.body}</div></details>)}</div><p className="mt-4 text-sm text-slate-700">After you continue, you will review and sign these documents through DanceFlow&apos;s secure signing step. Payment opens only after every required document is signed.</p></section> : null}
    </div>

    <aside className="lg:sticky lg:top-6 lg:self-start"><div className="border border-slate-300 bg-white p-5"><h2 className="text-lg font-semibold text-slate-950">Registration total</h2><div className="mt-4 max-h-80 divide-y divide-slate-200 overflow-auto border-y border-slate-200">{quote.lines.map((line, index) => <div key={`${line.description}-${index}`} className="flex justify-between gap-3 py-3 text-sm"><span className="text-slate-700">{line.description}</span><span className="font-semibold text-slate-900">{line.lineType === "discount" ? "−" : ""}{money(line.lineAmount, quote.currency)}</span></div>)}</div><div className="mt-4 space-y-2 text-sm"><div className="flex justify-between"><span>Subtotal</span><span>{money(quote.subtotal, quote.currency)}</span></div>{quote.discount > 0 ? <div className="flex justify-between text-emerald-700"><span>Discounts</span><span>−{money(quote.discount, quote.currency)}</span></div> : null}<div className="flex justify-between border-t border-slate-300 pt-3 text-lg font-semibold"><span>Total</span><span>{money(quote.total, quote.currency)}</span></div></div>{quote.errors.length > 0 ? <div className="mt-4 border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><ul className="space-y-1">{quote.errors.map((error) => <li key={error}>{error}</li>)}</ul></div> : null}<p className="mt-3 text-xs text-slate-500">The final price is confirmed when you continue; it follows the event&apos;s current pricing.</p>{checkoutError ? <div role="alert" className="mt-4 text-sm text-rose-700"><p>{checkoutError}</p>{checkoutErrors.length > 1 ? <ul className="mt-1 list-disc pl-5">{checkoutErrors.map((item) => <li key={item}>{item}</li>)}</ul> : null}</div> : null}<button type="button" onClick={beginCheckout} disabled={!quote.valid || submitting || !clientRequestId} className={`${buttonClass} mt-5 w-full`}>{submitting ? "Starting checkout…" : requiredDocuments.length > 0 ? "Continue to documents" : quote.total > 0 ? "Continue to checkout" : "Submit registration"}</button></div></aside>
  </div>;
}
