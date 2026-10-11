# Phase 10C.5 — source-to-UI matrix (Studio / Custom profile `studio_simple@2`)

Every option the Competition Setup Wizard shows is listed with its basis. Sources are the documents in
[governing-body-source-registry.md](governing-body-source-registry.md); `§` references are section and
printed page.

**Basis values:**

- **SRC** — source-grounded; the cited section was read.
- **STUDIO** — DanceFlow Studio / Custom convention, never presented as a governing-body rule.
- **OWNER** — owner operational knowledge.
- **NSPS** — NOT SPECIFIED IN PROVIDED SOURCE.

A partnership ("couple") is a structure inside an offering. It is never an offering name on its own: NDCA II.A.7 defines a couple as "a leader and follower without regard to the sex or gender of the dancer", for every classification.

Owner rules that apply everywhere: nothing is pre-selected (offerings, styles, levels, ages, dances), and every applicable option is visible.

## Ballroom (NDCA June 2026)

Each offering is a competition classification (profile keys `ndca_*`). Partnership offerings, Solo Star and Showdance choose **styles**. Each selected style becomes its own category (e.g. "Pro/Am — American Smooth") and only that style's dances can be chosen in it.

| Offering (wizard label) | Who dances | Basis | Styles | Divisions offered | Notes / fail-closed decisions |
|---|---|---|---|---|---|
| **Pro/Am** | Registered professional + registered Pro/Am Student Competitor | SRC II.A.4 (p4–5), II.B.7 (p7–8) | yes (all five) | **Level** (required): Newcomer, Beginner, Intermediate, Advanced, Pre-Bronze, Bronze, Silver, Gold, Gold Star, Supreme Gold (II.B.7.c, "may offer any or all"). **Age** (optional): A 19+, B 36+, C 51+, S1 61+, S2 71+, S3 76+, S4 81+ (II.B.7.f); Pre-Teen I to Youth (II.B.8.a: youth Pro/Am must use the amateur ages). | A–S4 are stated for Pro/Am **Multi-Dance** events; ages for single-dance events are NSPS, so the age axis is optional. Newcomer: first year, closed syllabus only (II.B.7.c(1)–(2)), shown as eligibility. Theatrical and Exhibition are **not levels** (see performances). Gender split ("separate or merged … by age or gender") is not modelled. |
| **Amateur** | Two registered amateurs | SRC II.A.2 (p4), II.B.6 (p7), X (p42–43) | yes | **Proficiency** (required): Bronze, Silver, Gold (Syllabus), Novice, Pre-Championship, Open Amateur (X.B). **Age** (required): Pre-Teen I ≤9, Pre-Teen II 10–11, Junior I 12–13, Junior II 14–15, Youth 16–18, Adult 19+, Senior I–IV (X.A.1). Organizer combinations Pre-Teen, Junior, Senior (X.A.2). Under 21 as an organizer add-on (X.A.3). | A couple's age is the older partner's (Pre-Teen–Adult) or the younger partner's (Senior) (X.A.6). Both partners must be eligible (X.C.6). At most two consecutive proficiency levels (X.C.9). These are eligibility notes only; 10C.5 does not enforce eligibility. |
| **Mixed Amateur** | Advanced amateur competitor/teacher + their amateur student; both registered amateurs | SRC II.A.5 (p5) | yes | One open division (STUDIO) | NDCA does not define Mixed Amateur divisions (NSPS); fails closed to one open division. |
| **Student/Student** | Two **adult** Pro/Am Student Competitors, danced with Pro/Am heats; not open to Open Amateur dancers | SRC II.A.6 (p5) | yes | One “Adult Open” division (STUDIO) | **Source conflict (unresolved, material):** II.A.6.b says adults only; II.B.8 describes youth Student/Student events. Fails closed: youth Student/Student is not offered. |
| **Professional** | Two registered professionals, 16+ | SRC II.B.1 (p6) | yes | **Contest** (required): Open Professional (II.B.1.a), Rising Star (II.B.1.b). Each is its own contest. | No professional age classes (only "16 years of age and older"). Rising Star eligibility rules (II.B.1.b(1)) are shown as an eligibility note only. |
| **Mixed Professional** | Professionals with other than their regular professional partner | SRC II.B.2 (p6) | yes | One open division (STUDIO) | Divisions NSPS. |
| **Solo Star** | One Pre-Teen, Junior or Youth amateur, syllabus routines singly in heats; never Adult/Senior | SRC II.A.3 (p4), II.B.10 (p8) | yes | **Age** (required): Pre-Teen I to Youth only. | Proficiency for Solo Star is NSPS, so there is no level axis. |
| **Showdance** | Couple | SRC II.B.4(3) (p6), XI (p46–47) | yes — the four primary styles only (XI.B.1) | One open division (STUDIO) | One style per show, using that style’s regular dances; up to 4 minutes (XI.B.2); couples supply their music (XI.B.4). Placed in order of merit (XI.B.9). |
| **Cabaret** | Couple; solo performance on and off the floor with lifts, own music | SRC II.B.4(2) (p6) | no | One open division (STUDIO) | Order by draw (III.D.10). |
| **Theatre Arts Compulsory** | All couples together to the same preselected music; lifts ≤ 50% of bars | SRC II.B.4(1) (p6), IX.A.1.f (p39) | no | One open division (STUDIO) | — |
| **Pro/Am Theatrical** | Pro/Am | SRC II.B.7.c (p7) | no | One open division (STUDIO) | NDCA lists Theatrical as a Pro/Am division and treats Theatrical as a lift-allowed performance category (IX.A.1.g(1)). Music for Pro/Am Theatrical is NSPS. |
| **Pro/Am Exhibition** | Pro/Am | SRC II.B.7.c (p7) | no | One open division (STUDIO) | Exhibition/Cabaret couples are exempt from dancing all dances (IX.A.1); lifts allowed (IX.A.1.g(1)). Music NSPS. |
| **Formation** | Teams of couples | SRC II.B.3, II.B.6.c (p6–7), XII (p48) | no | One open division (STUDIO) | Scoring conflict III.D.11 vs XII.N.3 (recorded). |
| **Team Match** | Teams of couples | SRC II.B.5, II.B.6.d (p6–7) | no | One open division (STUDIO) | — |

**Styles and dances** (SRC IX.A.1, p38–39): a style's dances are the only dances offered in that style's category.

- International Standard (NDCA "International Style Ballroom"): Waltz, Tango, Viennese Waltz, Slow Foxtrot, Quickstep.
- International Latin: Cha Cha, Samba, Rumba, Paso Doble, Jive.
- American Smooth: Waltz, Tango, Foxtrot, Viennese Waltz.
- American Rhythm: Cha Cha, Rumba, Swing, Bolero, Mambo.
- Additional American Style Dances (IX.A.1.e): only organizer-added dances.

**Not modelled (recorded, not offered):** Mixed Proficiency Amateur Couples (II.B.9: only one partner judged; needs scoring support); Studio Showcase (I.G: unplaced, proficiency %); separate gender categories; Pro/Am event type (single- vs multi-dance).

**Previous candidate `4a2e760e` → now:**

- **Ballroom "Couples"** is removed. It was a UCWDC Country dance-type name and silently modelled Amateur; Amateur, Mixed Amateur and Student/Student are now distinct.
- **"ProAm"** is now "Pro/Am".
- **"Professional"** now has Open Professional / Rising Star contests and a separate Mixed Professional.
- **"Showcase / Showdance"** is split into Showdance, Cabaret and Theatre Arts Compulsory, with the Pro/Am Theatrical and Exhibition divisions alongside.
- **"Solo"** (single-dancer routine) is now Solo Star (youth syllabus).
- **The International Standard / Latin dances**, previously missing, are added.

## Country (UCWDC 2026)

| Offering | Basis | Notes |
|---|---|---|
| ProAm | SRC ProPro/ProAm II.A.16, II.E.1 | Levels and ages as before (II.D ages, II.E.1 ladder); Studio Newcomer and Open Level are STUDIO. |
| ProPro | SRC ProPro/ProAm II.A.18, II.E.2, II.D | ProPro II / I plus the shared II.D ages. |
| Couples | SRC Couples booklet II.E, II.D | A UCWDC dance type; used **only** in Country. |
| Showcase | SRC Couples / ProPro II.G.2.a | Set music per dance. |
| Spotlight | SRC ProPro II.A.20, II.K.8 | Competitor-selected music, ProAm / ProPro. |
| Solo routine (Studio) | STUDIO | One dancer, a routine. **Not UCWDC.** UCWDC Solo Medley (Couples II.A.20, II.M.1.h.i, p2/p13) is a **couple's** multi-dance Showcase routine for Showcase Masters and Crown only; it is **not modelled yet** and was not renamed onto the single-dancer offering. |
| Team | SRC Teams booklet II.D (no ages) | One open division. |

## West Coast Swing (WSDC 2026.1C)

| Offering | Basis | Divisions |
|---|---|---|
| Jack & Jill | SRC (Registry rules) | WSDC skill contests (Newcomer–Champion) and separate age-based contests (Juniors, Sophisticated, Masters) — unchanged. |
| Couples (Studio) | STUDIO | Studio levels only. WSDC defines no Couples contest; NASDE is not a supplied source. |
| Pro-Am (Studio) | STUDIO | Studio levels only (WSDC mentions Pro-Am Jack & Jill / Strictly Swing only in a judging-conflict exception). |
| Routine / Showcase (Studio) | STUDIO | One open division. |

Previously, WCS Couples and ProAm used the WSDC Jack & Jill division structure. They now use Studio levels, and only Jack & Jill carries WSDC metadata.

## Other / Studio-defined

All offerings are STUDIO and use their own definitions. Nothing is shared with the UCWDC, WSDC or NDCA offerings; "ProPro" and "Jack & Jill" are labelled as Studio.

## Source conflicts carried by the profile

| Key | Conflict | Effect |
|---|---|---|
| `ndca_student_student_youth` | NDCA II.A.6.b (adults only) vs II.B.8 (youth Student/Student events) | Material; fails closed (no youth Student/Student). |
| `ndca_formation_scoring` | NDCA III.D.11 (cumulative points allowed) vs XII.N.3 (Skating required) | Material for a sanctioned NDCA profile; Studio Formation uses Studio placements. |

## Audit gate for later Competition OS phases

1. **Registry.** Every governing-body document is listed in the source registry with its edition and SHA-256.
2. **This matrix.** It is updated in the same PR as any profile change. A profile change without a matrix diff is incomplete.
3. **Automated checks** in `setup.phase10c5` / `ballroom.phase10c5`:
   - each offering belongs to exactly one style;
   - each offering's origin matches its style's governing body or is Studio;
   - every source-grounded value cites a section;
   - nothing is pre-selected;
   - styles constrain dances.
4. **Primary text.** Every source-grounded row is checked against the rule text, not a summary.
5. **Fail closed.** An eligibility interpretation that is unresolved or NSPS is not offered; it is recorded here.
6. **Owner walkthrough.** The checklist is derived from this matrix.
