# TW-4 Stage B: studio identity (ConfiDance as first pilot subject)

Status 2026-10-17. Local preparation only. **Nothing was sent to Twilio, no resource was created, no hosted DEV/PROD change, no fee, no SMS. Stage B and Stage C remain NOT authorized.** Twilio facts marked "design" come from `TW-4_ISV_SMS_Onboarding_Design.md` / `TW-4_ConfiDance_Registration_Path.md` and were not re-verified today.

## 1. Correction and what changed in the tooling

GenX TotalTech LLC is the ISV **Primary** Customer Profile (DanceFlow's own identity). A Secondary Customer Profile describes a *customer* (a studio) with its own legal entity. The earlier plan to draft a Secondary profile on GenX's own name and EIN is withdrawn.

| Area | Before | Now |
|---|---|---|
| Checker (`businessFile.ts`) | compared the file to the Primary name; an identical name was only a note | the ISV identity is an **error** (name equals the Primary's, or contains `genx`/`totaltech`, any punctuation or spelling); an `@idanceflow.com` representative is an error; Primary-industry and "same LLC type" notes removed; entity-type note is neutral |
| `new-business-file.ps1`, `check-business-file.ps1` | default file `genx-business.json` | **no default file**; `-Studio <short-name>` (-> `<short-name>-business.json`) or `-Path`; `genx`/`totaltech` refused; the checker reads only the file you name |
| Template | defaults `llc`, `EDUCATION`, `danceflow`, `ceo` | every enum is a placeholder the owner must choose; no studio named |
| Launcher (`run-stage-b.ps1`) | any wizard-valid file | additionally refuses the ISV legal name and a DanceFlow representative email; EIN prompt says it must be the studio's own EIN |
| `.gitignore` | `genx-business*.json` | also `*-business.json` |
| Unchanged | | S10 hard stop, network fence, `authorize-b` typed phrase, `RUN`, Stage C token, loopback-only DB, API-key-only credential, mailbox `CONFIRMED`, cleanup/evidence rules, runner, real adapter, payload builders, DB |

The existing private GenX file was not opened, read, copied or modified (size and timestamp checked before and after: 624 bytes, unchanged). A separate template was created at `%LOCALAPPDATA%\tw4-validation\private\confidance-business.json` (unfilled, outside the repository, folder ACL restricted to the current Windows user).

## 2. What ConfiDance must provide (not assumed: entity type and EIN are unknown to us)

The pilot path (wizard and runner) supports an entity **with an EIN**. ConfiDance supplies, from its own IRS letter and formation documents:

| Item | Source of truth | Notes |
|---|---|---|
| Legal name | IRS EIN letter (CP 575 / 147C) | exact spelling; not the display name "ConfiDance Studio" unless identical |
| Entity type | formation documents / IRS letter | one of LLC, Corporation, Partnership, Non-profit, Co-op. **Not** sole proprietor (see §4). It is sent to Twilio as the mapped business type |
| EIN | IRS letter | 9 digits, hidden prompt only; design says ConfiDance's owner enters it in the wizard, DanceFlow staff never type it (see §5) |
| Physical address | registered/operating address | street, no PO box (PO box usually fails verification) |
| Authorized representative | an owner/officer of ConfiDance | first/last name, title, position, own business email (free-mail warns), US mobile that can receive a code |
| Website | `https://www.idanceflow.com/studios/confidance-studio` (live) | choose `own` with that URL. `danceflow` would resolve to the throwaway local test studio's page, which does not exist |
| Industry | owner choice | wizard offers EDUCATION or CONSUMER |
| Preferred area code | owner choice | for the number purchase later |

## 3. Differences between ConfiDance's real requirements and the current pilot assumptions

1. **Standard + MIXED vs reality.** The design recommends Standard brand + `MIXED` for the pilot. Tier/use case depend on ConfiDance's volume and entity; Low-Volume Standard + `LOW_VOLUME` (cheaper) needs Twilio's answer to Q4a and a TW-3 enum migration. A sole proprietor would instead use the Sole Proprietor brand (OTP to the owner's mobile, 1 campaign, 1 number; design). So the tier is a *decision made after* we know ConfiDance's entity and EIN, not before.
2. **Stage B validates only the Secondary profile draft (S1–S10).** It never exercises the A2P TrustProduct, brand (Standard vs LVS vs Sole Prop), campaign or number. Standard-brand/MIXED assumptions remain unproven until Stage C or the real submission.
3. **Stage C is designed around a Twilio MOCK brand for a throwaway studio.** A mock brand under ConfiDance's real Secondary profile would submit that real profile for Twilio review (irreversible). Stage C cannot be reused as-is for ConfiDance and is not being prepared here.
4. **Identity the harness uses is the business file, not the pilot studio.** The harness seeds a throwaway local studio (`TW4 Validation Studio`) and names Twilio resources `df:production:<local studio uuid>:S<n>`. ConfiDance's later real onboarding (its production studio id) will create its own resource set; Stage B drafts are not adopted by it and would be duplicates sitting beside it.
5. **Opt-out/AOO, consent evidence, Terms/Privacy pages live on PROD, 4B–4D slices:** unchanged by this work; see `TW-4_ConfiDance_Registration_Path.md`.

## 4. Applicable A2P path by ConfiDance's situation (design; to confirm)

| ConfiDance has | Path | In v1 tooling? |
|---|---|---|
| EIN, any supported entity | Secondary Customer Profile + A2P TrustProduct + Standard (or LVS) brand + campaign | yes (Stage B covers the profile draft only) |
| No EIN (sole proprietor) | Sole Proprietor brand (OTP, 1 campaign/1 number) | **no** (excluded from v1; the wizard exits to "not yet supported") |
| EIN but is an LLC | still EIN path (the "LLCs ineligible" note applies to Sole Proprietor) | yes |

## 5. Risks and decisions for the owner

**Owner decision 2026-10-17 (clarified):** the owner is both the DanceFlow founder and the owner of ConfiDance, and personally operates the local terminal and types the EIN into the existing hidden prompt. The launcher is NOT being redesigned for a separate studio owner. Stage B and Stage C remain unauthorized until the owner gives separate written authorization. Ownership alone does not establish a distinct legal identity: see §5a.

1. **Same person, two sides.** The "DanceFlow staff never type a studio EIN" principle is met by the owner acting as ConfiDance's authorized representative; record that capacity in the written authorization. No third-party consent is needed only if the owner wholly owns ConfiDance. Stage B drafts still carry the real identity and may persist at Twilio (deletion unverified).
2. **Stage B drafts for ConfiDance are not its production onboarding** (§3.4) and add duplicate identity records at Twilio. The Twilio Support inquiry was dropped as an automatic prerequisite (owner decision 2026-10-17); contact Support only if an unresolved issue materially prevents safe execution.
3. **Same-EIN risk is removed** by the ISV-identity refusals, but the launcher cannot compare the typed EIN to the ISV's EIN (it never holds it). A local-only mitigation is possible: Stage A already reports the Primary's EIN *last four*; a read-only preflight comparison inside the runner's authorized window would close this, but it touches the real Twilio boundary and needs an Opus review. Not built.
4. Stage C/mock-brand strategy for a real studio (§3.3) needs its own design decision.
5. Unchanged prerequisites: compliance mailbox send/receive verification, Standard API key and Account SID on the execution day, written authorization, billing note, the Twilio Support answer.

## 5a. Verify ConfiDance's legal entity and tax-registration eligibility (owner, before any run)

Owning both businesses does not make ConfiDance a distinct Secondary-profile subject. Twilio's profile is for a legal entity with a tax registration. Confirm each item from documents, not memory. The tooling cannot verify any of this (it never sees the EIN).

| Question | Evidence | If the answer is no |
|---|---|---|
| Is ConfiDance its own legal entity (LLC, corporation, partnership, non-profit, co-op) formed in a state? | Secretary of State record / articles of organization | A trade name (DBA) of you personally or of GenX TotalTech LLC is not a separate entity; this path does not apply |
| Does it have its own EIN, different from GenX TotalTech LLC's? | IRS CP 575 or 147C letter in ConfiDance's legal name | No EIN (sole proprietor, SSN-based) is the Sole Proprietor path, excluded from v1. Sharing GenX's EIN means it is the ISV's own identity, which is refused |
| Does the legal name on the IRS letter match the business file exactly? | the letter | Twilio compares names; fix the file |
| Is the address the entity's physical address on file? | letter / state record | PO boxes usually fail verification |
| Is the representative an authorized person of that entity? | operating agreement / officer record | use the correct signatory |
| Does the entity's legal name contain "GenX" or "TotalTech"? | the name | the checker and launcher refuse it by design |

A single-member LLC has its own entity and normally its own EIN, so it qualifies. A disregarded or unregistered business that uses your SSN or GenX's EIN does not, and Stage B on ConfiDance would not be valid.

## 5b. What the ISV-identity guard is, and is not

The refusals in the checker and the launcher (legal name containing `genx`/`totaltech`, a `@idanceflow.com` representative) are an **accidental-reuse safeguard**. They catch the mistake of filling in the ISV's own details. They are **not** an authorization control, **not** a legal-identity verification and **not** a security boundary: they cannot prove who a business is, and the operator controls both the file and the EIN prompt.

Known limitations, recorded as follow-ups (not implemented; this PR is not expanded):

| # | Limitation | Follow-up |
|---|---|---|
| F1 | A studio whose legal name merely contains "genx" or "totaltech" (for example "Genxtreme Dance LLC") is refused (false positive) | Replace the substring rule with a word-boundary or exact-entity rule when a real case appears |
| F2 | Evasions pass: leetspeak ("Tota1Tech"), a lone lookalike character ("GenΧ" using a Greek letter), a subdomain email such as `x@mail.idanceflow.com` | Normalize confusables and match subdomains if the guard is ever promoted beyond a typo check |
| F3 | The launcher never holds the ISV's EIN, so it cannot detect the ISV's EIN typed at the hidden prompt | A read-only comparison of the typed EIN's last four with the Primary profile's last four (Stage A already reports it) inside the authorized window. It touches the real Twilio boundary and needs an Opus review first |

## 5c. Mandatory prerequisite before any real Stage B run

The manual legal-entity and EIN verification in §5a is **mandatory**: ConfiDance must be confirmed from documents as its own legal entity with its own EIN (different from GenX TotalTech LLC's) before Stage B is authorized. Passing the checker or the launcher does not satisfy it, and neither does the guard in §5b. Stage B and Stage C remain unauthorized.
