# OD-02 Option A: minors-enabled Competition OS (design only)

**Status: DESIGN ONLY. Nothing here is implemented, approved for build, or authorized to ship.** No SQL, migration, deployment, merge or public activation is authorized by this document.

- Owner decision: OD-02, 2026-11-23. Option C (prohibit under-18 competitors) for first activation; **Option A is the future minors-enabled design**. The prohibition is a *temporary launch restriction*, not a permanent exclusion of young dancers. The restriction is implemented in the companion PR (`src/lib/competition/minorsGate.ts`, rule-register entry `DFPOL-OD02-NO-MINORS-LAUNCH`).
- Governance: [RULEBOOK_GOVERNANCE.md](RULEBOOK_GOVERNANCE.md). Where a rulebook is silent this document says `NOT SPECIFIED IN PROVIDED SOURCE` and labels the behavior DanceFlow or organizer policy. Rulebook text is paraphrased; only section references and short phrases appear.
- Shared concerns: OD-03 (age validation per body), OD-27 (gender / Mixed-Role) and OD-30 (reference dates). Collecting a date of birth and guardian data is **one privacy decision** shared with those items; decide once.

## 1. What each governing body requires (re-read in the pinned PDFs, SHA-256 matched to the source registry)

| Body / document | Edition | Section (page) | What it says (paraphrase) | Class |
|---|---|---|---|---|
| UCWDC Couples | 2026 (v1-26-2026) | II.O.2 (PDF p16) | Competitors under the legal age of 18 must be accompanied by a parent or legal guardian who has written parental permission to act as "guardian" and is responsible for the minor's safety and conduct at all times. | mandatory |
| UCWDC ProPro/ProAm | 2026 (v1-26-2026) | II.O.2 (PDF p16) | Same clause. | mandatory |
| UCWDC Line Dance | 2026 (v1-26-2026) | II.O.2 (PDF p16) | Same clause. | mandatory |
| UCWDC Teams | 2026 (v1-26-2026) | II.N.2 (PDF p10) | Same clause. | mandatory |
| UCWDC Couples / ProPro-ProAm | 2026 (v1-26-2026) | II.B.1.a (PDF p5) | Current Associate Membership, with birthdate included, is required before registering; used to track eligibility and graduation. | mandatory (membership), data is DOB |
| UCWDC (all four) | 2026 (v1-26-2026) | II.O.1 | Competitors may be required to sign an event waiver covering liability, data collection, recordings and privacy. Not minor-specific. | organizer discretion |
| NDCA Rule Book | June 2026, Master v1 | III.C.5 Entry Blanks (printed p19, PDF p26) | The organizer's entry blank must also carry a parent or guardian's consent signature for Juniors. | mandatory |
| NDCA Rule Book | June 2026, Master v1 | VI.A.11, Registration - General (PDF p39) | A registrant under 18: a parent or guardian is responsible for learning the rules as they relate to the child. | informational |
| WSDC Registry Event Rules | Version 2026.1C | Definitions, Age-based Contests (PDF p3) | Juniors are those younger than 18 by the close of the event. | definition |
| WSDC Registry Event Rules | Version 2026.1C | 3.1.2.e (PDF p10); 1.1.9 (PDF p4) | Registry Events must be open to everyone but may set a minimum contestant age, published in the event's rules (rules posted 90 days before the event). | permitted exception |

**WSDC: not verified.** A text search of the pinned PDF for parent, guardian, minor, under 18 and legal age found only the provisions above. No WSDC rule on minors accompaniment, guardian consent or waiver was located, but the document was not re-read in full for this design, so the absence of such a rule is **NOT VERIFIED**. Do not state a WSDC minors rule in product copy until the owner has a full read recorded.

**Not specified in the provided sources** (record as DanceFlow or organizer policy when decided, never as a body rule): what "accompanied" means operationally (on site? in the venue? at each heat?), whether a team of minors needs one guardian per minor, the form of the "written parental permission", who may be a "legal guardian", whether UCWDC also requires guardian consent for entering (as opposed to being accompanied), any chaperone or supervision ratio, and whether NDCA's "Juniors" age band equals under 18 (that is the OD-03 age-band audit). The UCWDC legal-age wording means a jurisdiction with a different age of majority is **NOT SPECIFIED IN PROVIDED SOURCE**.

Citations of the reviewed registry rows: `governing-body-source-registry.md` (UCWDC four 2026 rule books, NDCA June 2026, WSDC 2026.1C). The WSDC 2027 draft is `not current` and was not used.

## 2. Requirements Option A must satisfy

1. **Per-competitor, not per-buyer.** Age is evaluated for each entry participant. A guardian may be the buyer; consent is recorded against the minor competitor, not the buyer account.
2. **Age basis.** Compute age per body and event from the date of birth: UCWDC "legal age of 18" (at the event, as the rule is worded; confirm), NDCA Juniors band (OD-03 / OD-30), WSDC "by the close of the event". Reference dates differ by body; the minors flag must not be a single global boolean computed once.
3. **Consent artifact.** For every minor entry: a guardian identity, a signed consent bound to this event, this minor and this guardian, and (where the body requires it) an accompaniment declaration naming the person who will accompany. Organizer-attestation alone is not a substitute where the rulebook asks for a signature (NDCA III.C.5) or written permission (UCWDC II.O.2).
4. **Fail closed.** No date of birth, no consent, unverifiable guardian, or lapsed consent means the entry cannot be confirmed, scheduled or checked in. This extends the current restriction rather than replacing it: the gate stays and gains an exception path only once Option A ships.
5. **Minimise data.** Collect the date of birth only for entry participants; collect guardian name, contact and relationship only when a minor is present; never ask for a child's government ID; no child photos or school information.
6. **Registration changes cannot bypass.** Any later edit that adds a participant, swaps a partner or moves a minor to another entry re-runs the check and, if needed, the consent.
7. **Unaffected areas.** General DanceFlow student records, NSI, studio scheduling and non-competition events are out of scope and must not gain minors fields.

## 3. Guardian consent and signatures

- **Reuse the Phase 8 signing checkpoint** (`beginEventSigningCheckpoint`, `event_signing_checkpoints`, event document requirements) instead of building a second signature stack. Add a per-minor requirement kind `minor_guardian_consent` whose signer is the guardian and whose subject is the minor competitor attendee.
- **One signature per minor per event** (or per entry set; owner choice), not per buyer. A guardian registering three children signs three consents (or one consent listing three children if counsel approves).
- **Guardian authentication.** The guardian signs through the existing tokenized signing link sent to the guardian's verified email. Registration by someone other than the guardian is allowed; entries stay `pending_guardian_consent` until the guardian signs. Email verification of the guardian address is required before the signing link is honored.
- **Consent content (policy, owner and counsel to approve):** guardian name and relationship, acknowledgment of the body's accompaniment requirement where applicable, emergency contact, liability waiver for the minor, media/recording consent (separate, optional where the rulebook allows). Wording is DanceFlow or organizer policy; it must not be presented as rulebook text.
- **Evidence retained:** signed document hash, timestamp, signer name, IP/user agent per existing signing evidence, template version.
- **Revocation:** guardian may withdraw consent; the entry returns to `pending_guardian_consent` and is excluded from scheduling and check-in until resolved.

## 4. Accompaniment

- Applies where UCWDC (II.O.2 / II.N.2) governs. DanceFlow records *who will accompany* and obtains the guardian's written permission; whether DanceFlow can *verify* on-site accompaniment is a day-of-operations question (check-in desk).
- **Check-in gate:** the check-in flow shows a "minor: guardian accompaniment confirmed" step before presence is recorded; staff record the accompanying adult's name (not ID scans) with a timestamp.
- Teams: the rule applies to each under-18 team member; the team entry needs a roster-level view showing every minor and the accompanying guardian for each.
- NDCA and WSDC: no accompaniment requirement was found in the cited provisions (WSDC not verified); do not impose one as a body rule. An organizer may add it as organizer policy.

## 5. Permissions and access

| Role | Sees | Can do |
|---|---|---|
| Organizer owner / admin | Minors list per event (name, entry, consent status); guardian name and contact | Request consent, mark waived with a required reason (waivers are exceptional and audited), export for on-site staff |
| Registration / check-in staff | Consent status and accompanying-adult name for the minors in their session; not the full DOB | Confirm accompaniment, record the accompanying adult |
| Judges, scrutineers, scoring staff | Nothing about minors | None (age bands are visible only as division labels, as today) |
| Guardian | Their own minors' entries and consent | Sign, withdraw, update contact |
| Buyer who is not the guardian | The order | Cannot sign consent or see guardian data beyond their own entry |

Row-level security must follow the existing event-staff patterns; any new table is event-scoped and service-role-only for writes.

## 6. Privacy controls

- DOB and guardian fields are classified **sensitive**; excluded from public pages, emails, calendar feeds, embeds, exports shared with third parties and the public results.
- Never log DOB, computed age, guardian contact or consent text. Logs carry ids and reason codes only (as in the current gate).
- Staff views show the minor flag and consent state; DOB is shown only to roles that need it and is masked by default.
- No analytics events carry age. No AI/Aria features read minors data.
- Do not send marketing to minor contacts. Guardian contact is used only for the event (consent, schedule, safety).
- Right to erasure on request, subject to retention below.

## 7. Retention and deletion

- **Proposal (owner and counsel to decide):** keep signed consents and accompaniment evidence for the dispute window of the event plus a fixed period (suggest 3 years, because injury claims by minors can be tolled; counsel to confirm), then delete or anonymise DOB and guardian contact, keeping an aggregate count.
- Competitor DOB for adults follows the existing attendee retention; minors' DOB is purged at the end of the minors retention period, not with the adult schedule.
- A purge job needs its own approval; none is proposed for build now.

## 8. Audit

Append-only audit rows (event, actor, action, subject entry id, before/after state, reason code, timestamp) for: minor detected, consent requested, consent signed, consent withdrawn, waiver granted, accompaniment recorded, entry moved or edited, data viewed by staff (read audit for DOB reveal), export generated, purge executed. No DOB or consent text inside audit rows. Reuse the existing audit patterns rather than adding a parallel log.

## 9. Data model sketch (illustrative; NOT a migration, not approved, not written)

```
event_competition_attendee_age        -- one row per attendee who is in an entry (age basis)
  attendee_id (fk), event_id, dob_year_month_day (date, sensitive), dob_provided_at,
  is_minor_for_event (derived at read; never trusted from client)

event_competition_minor_consents      -- one per minor per event
  id, event_id, attendee_id (minor), guardian_name, guardian_relationship,
  guardian_email_verified_at, guardian_phone?, emergency_contact?,
  status (pending|signed|withdrawn|waived), signature_id (fk event_document_signatures),
  accompanying_adult_name?, waived_by?, waiver_reason?, created_at, updated_at

event_competition_minor_audit         -- append-only; ids and codes only
```

Notes: the age flag is *derived per body/event* (section 2.2); only the DOB is stored. A DB-level guard (a trigger or function check that an entry cannot reach `confirmed` while a participant is a minor without a signed consent) is the reliable enforcement and **needs a separate SQL approval**; the app-layer check alone leaves a service-role bypass. RLS: event-staff scoped reads, no public access, writes through audited RPCs only.

## 10. Migration from the launch restriction to Option A

1. The launch gate stays on; Option A adds a per-event feature switch (`minors_allowed`), default off, owner-controlled.
2. When on, the gate changes from "refuse minors" to "route minors through consent": entries with a minor are created in `pending_guardian_consent` and cannot be confirmed or scheduled until signed.
3. Existing events that opened under the restriction contain no minors, so no backfill is needed.
4. Rule-register entries `UCWDC-OD02-ACCOMPANY-*` and `NDCA-OD02-JUNIOR-ENTRY-CONSENT` move from `unsupported` to `verified_compliant` only when implementation and tests exist; `WSDC-OD02-MIN-AGE-PUBLISHED` is revisited after a full WSDC read.

## 11. Open decisions (owner)

1. Consent granularity: per entry, per event, or per minor.
2. Retention periods (section 7) and counsel review of consent wording.
3. Whether DanceFlow takes on on-site accompaniment evidence, or only records the guardian's attestation.
4. Age basis per body (shared with OD-03/OD-30), including whether UCWDC "legal age" should use the event date or the entry date.
5. Whether organizers may require guardian presence beyond what the body requires (organizer policy).
6. Collecting gender (OD-27) and DOB in one consent-minimising step.
7. WSDC: a full read of the Registry Event Rules for any minors provision before any copy states one.
8. SQL: a separate approval for the tables and the DB-level guard in section 9.

## 12. Out of scope

Implementation, migrations, UI mockups, deployment, activation, and any contact with organizers or governing bodies.
