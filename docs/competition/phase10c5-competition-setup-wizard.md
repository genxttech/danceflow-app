# Phase 10C.5 — Competition Setup Wizard + Draft Generator

Status: implemented on DEV/local only (not pushed, no PR, PROD untouched).

## What organizers get

`/app/events/[id]/competition/new` is now a guided setup that ends with **Create Competition Draft**:

1. **Purpose**: Competition, Showcase / Performance, or Competition + Showcase.
2. **Styles**: Country, West Coast Swing, Ballroom, Other / Studio-defined, or Multiple styles.
3. **Adjudicated?**: Adjudicated (Placements or Ratings) or Non-Adjudicated. A showcase is always
   Non-Adjudicated.
4. **Rules**: Studio / Custom Rules. UCWDC, WSDC and NDCA are shown as "Not available yet" and
   generate nothing.
5. **Sanction**: shown only for rules that can be sanctioned, so it is never asked for Studio / Custom.
6. **Offerings**: the entry formats for each style. The list comes from the profile, not a universal list.
   For example, Country has no Professional format, while Ballroom and Other do.
7. **Divisions**: levels and optional age groups, chosen per entry format.
8. **Dances**: chosen per entry format. Custom dances are allowed where the style permits them.
9. **Rounds**: every division starts with a Final (Performance when Non-Adjudicated).
10. **Registration basics**: the event registration window and whether an account is required.
11. **Pricing**: one model per entry format:
    - per dance;
    - per entry;
    - included with registration fee;
    - free;
    - configure later.
12. **Review**: the counts, structure and pricing come from the same derivation as the payload.
    When any pricing is deferred, Review says "Pricing requires completion before registration can open."

Answers survive Back, Continue and refresh, but only in this browser tab (`sessionStorage`, guarded).
The stored copy is cleared when the draft is created. There is no answers table.

## Authority

- **`deriveDraft(answers, profile)`** (`src/lib/competition/setup/draft.ts`) is the single derivation
  authority. The server action re-derives from the stored profile, so the browser never supplies the
  payload.
- **`create_competition_draft(event, spec)`** writes everything in one transaction. It:
  - requires a manager;
  - takes the per-event advisory lock, shared with `create_simple_competition`;
  - accepts only a schema-2 active profile;
  - creates one draft program per style, plus a separate showcase program;
  - creates their categories, divisions, rounds, dances and offerings;
  - creates a program-scoped per-competitor fee rule for "included" pricing;
  - saves the event registration basics.

  Every program stays an unpublished draft with registration CLOSED. The request key identifies the
  full set, so replaying it returns the same programs. If the same key arrives with different choices,
  the call fails.
- **Configure later** sets `contests.configuration.setup.pricing_pending`.
  `open_competition_registration` refuses to open while any category is pending.
  `set_competition_category_pricing` (Overview → "Pricing to finish") completes the pricing and clears
  the flag. It works only while registration is closed.

## Database (`20261113090000_phase10c5_competition_draft.sql`)

- **`studio_simple@2` "Studio / Custom Rules"**:
  - Append-only; v1 is unchanged and `create_simple_competition` is unchanged.
  - The TypeScript mirror is `src/lib/competition/setup/studioCustomV2.ts`, with a drift guard test.
- **Pricing mapping**:

  | Model | Rule pricing | Amount stored as |
  |---|---|---|
  | per dance | `per_dance` | offering `entry_fee` |
  | per entry | `flat_entry` | `base_entry_fee` |
  | included | `flat_entry` 0 | `flat_per_person` fee rule on the program |
  | free | 0 | — |
  | later | 0 | `pricing_pending = true` |

- **Rollback**: `rollback/20261113090000_phase10c5_competition_draft_rollback.sql`.
  - It refuses while pricing is pending.
  - It restores `open_competition_registration` byte-for-byte and drops the two new functions.
  - It **retires** v2 rather than deleting it. Re-applying the migration reactivates the identical v2.

## Overview

The Overview shows one card per competition setup, so multiple styles plus a showcase each get their
own publish and registration controls. Each card also has a pricing-completion panel when needed.

## Carry-forwards

- Bundles / package pricing.
- Governing-body profiles (UCWDC, WSDC, NDCA) and sanction status.
- Preliminary rounds generation from entry volume.
- An authenticated owner walkthrough of the wizard on DEV.
