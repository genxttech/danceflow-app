# NSI P1-A: staff-minted links (decision options and a draft resolution, 2026-11-23)

Status: **draft for independent review; engineering resolution proposed, no code, SQL, flag, env or email authorized.** Gate A stays closed. NSI has no pricing or billing entitlement. Everything below marked **[recommended, pending owner decision]** is a draft default; silence is not approval.

Goal of this note: turn P1-A into a **rule engineering can implement without the owner**, so the only owner decisions still open on the minor/evidence path are **O11** (does a declared adult need staff confirmation) and **O5b** (may a studio set the age of majority below 18).

## 1. The problem
The app derives the invitation token and sends only its hash to the database (M12). Whoever runs that app code, or any staff member who can trigger "send or resend a link" through a future UI, can know the token it just minted. A minted link can therefore be exchanged by that person and used to answer "as the student". M12 already makes this attributable (`issued_by_user` on the invitation and on every session it creates; `invitation_issued` and `link_exchanged` audit events), but attribution is not prevention, and the evidence record does not yet say the answers may have come from someone other than the student.

## 2. Who can mint (the three origins)
| Origin | `issued_by_user` | Example |
|---|---|---|
| System | null | the app issues the first link automatically when an obligation is created |
| Staff-issued | the staff user | a manual "send a new link" or "resend" by owner/admin/front desk |
| Guardian-path | the staff user or null | guardian invitation (I3-2): always requires the L2 email code on top of the link |

The marker needed everywhere downstream is derived, not stored twice: **`staff_minted = (issued_by_user is not null)`**, read from the session (immutable copy) so a later invitation change cannot rewrite history.

## 3. Options
| # | Option | What it stops | Cost | Residual risk |
|---|---|---|---|---|
| A | Record the minting actor only (M12 today) | nothing (attributable, not prevented) | done | staff can submit as the student and the evidence does not say so |
| B | **A plus an evidence marker: a submission through a staff-minted session is stored as `staff_assisted`, never student-authored; student-authored evidence requires a system-minted link** | self-minting being mistaken for student evidence | one column on the response/evidence write (I3-4), one derived read, tests; no new RPC | a compromised app server can still mint a system-origin link (stolen service key) |
| C | B plus two-party issue for guardian links only (staff request, app-server finalize) | staff self-minting a guardian-consent link; a stolen service key alone | two RPCs, a pending-invitation state, expiry of unfinalized requests, a new catalog level, a new test matrix | a compromised app server plus any staff request can still mint |
| D | Two-party issue for every link | staff self-minting everywhere | everything in C for the student path too; the app server becomes a required hop for every send | same as C; high cost for a path where a forged answer is low stakes |

## 4. Recommendation (draft) and the rule to implement
**Option B for the student path, Option C only inside I3-2 for guardians.** Rationale: a forged student answer costs the studio data quality and is attributable; a forged guardian consent for a minor is the case where prevention matters, and I3-2 already needs the L2 email code and its own RPC set.

Rule set (engineering, not owner decisions):
1. A link session never produces student-authenticated evidence (M12 P1-A rule, unchanged). Assurance stays `declared_unverified`.
2. **Provenance on every write from a session:** session id, invitation id, generation, and `staff_minted` (derived from the session) are stored with each draft save and submit (I3-4). The staff read shows the word "completed by staff" for `staff_minted` submissions and never the minting staff member's name to the student.
3. **`staff_minted` submissions are `staff_assisted` data entry.** They may complete the obligation for studio purposes (staff legitimately fill forms in the room), but they are never counted as student-authored evidence, never satisfy a guardian-consent requirement, and carry the marker into exports and into the evidence core.
4. **Minor determination interaction (I3-3/M15):** a declaration made through a staff-minted session is recorded with provenance `declared_via_staff_link` (already in the M15 spec) and is **never** accepted as a self-declaration of adulthood; it only routes (a declared minor goes to the guardian flow). A declared adult through a staff-minted link cannot occur by design.
5. **Guardian path (I3-2):** guardian consent needs the L2 email code, L3 verified link, or L0 staff attestation; a copy of the link never counts, whoever minted it. Guardian invitations use two-party issue (Option C): staff call a request RPC without a hash; only the app server's finalize RPC supplies the token hash; unfinalized requests expire.
6. **Audit:** `invitation_issued`, `link_exchanged`, draft save and submit events carry `staff_minted` and the session id; none carries a token, a hash or a personal value.

## 5. What this leaves for the owner
- **O11 [recommended, pending owner decision]:** a self-declared adult (no trusted birthday) always needs staff confirmation before the obligation completes. Rule 4 means a staff-minted link cannot produce that case, so O11 only concerns links the student received.
- **O5b [recommended, pending owner decision]:** studios cannot lower the age of majority below 18 (the setting is clamped).

Every other P1-A question is resolved by the rules above. If the owner rejects Option B, the fallback is Option D (high cost) and the I3-4 provenance work is unchanged because it already stores the marker.

## 6. Tests required before the rules ship (I3-4 and I3-2, not this note)
- A session from a staff-issued invitation: `staff_minted` true; from a system invitation: false; the value is immutable on the session.
- A submit through a staff-minted session is stored `staff_assisted`; the same submit through a system-minted session is student-authored; neither path changes `respondent_assurance`.
- A staff-minted declaration of adulthood is refused; of minority is accepted and routes to the guardian flow.
- Guardian consent through a copied or staff-minted link without a verified challenge or attestation: refused.
- Two-party issue (I3-2): a staff request without finalize never yields a usable link; finalize by a non-service role is refused; an unfinalized request expires; the hash never appears in any staff-readable row.
- Audit rows for all of the above contain the marker and no token, hash, birthday or email.

## 7. Dependencies and ordering
M15 (minor determination) already records `declared_via_staff_link`; nothing in M12 to M15 changes. The marker is stored when I3-4 writes responses; the two-party RPCs ship with I3-2 (M16). Until both land, I3-4 save/submit and any UI or outbox wiring stay blocked, as in `NSI_Resume_Status.md` §10.
