# Phase 10C.2 — Create Event UX simplification

App-only. No SQL, no schema, no new stored values. Edit Event keeps its existing layout.

## Event types

The form offers the same nine stored types as before (`group_class`, `social_dance`, `workshop`, `party`, `competition`, `showcase`, `festival`, `special_event`, `other`). The server also accepts `intensive`, `bootcamp` and `retreat`, but the form never offered them and they were not added.

| Top-level choice | Stored type(s) |
| --- | --- |
| Group Class | `group_class` |
| Social or Party | `social_dance` (default), `party` |
| Workshop or Festival | `workshop` (default), `festival` |
| Competition | `competition` |
| Showcase | `showcase` |
| Special Event or Other | `special_event` (default), `other` |

Default selection is unchanged (`group_class`). Competition keeps the 10C.1 CTA and redirect.

## Visibility / lifecycle → stored fields

Previously the form wrote `status`, `visibility` and `public_directory_enabled` through a 3-mode "publishing destination" plus two raw selects. Now two organizer choices write the same three fields:

| Choice | Stored |
| --- | --- |
| Public | `visibility = public` |
| Public + "Also show in DanceFlow Discovery" | `visibility = public`, `public_directory_enabled = true` |
| Anyone with the link | `visibility = unlisted` |
| Studio only | `visibility = private` |
| Save as draft | `status = draft` |
| Publish now | `status = published` (the public event page and cart checkout only serve `published`; registration is gated by `registration_required` and the registration window) |

Draft is a lifecycle status, independent of the audience. Discovery is stored only for the public audience (the server already forces `visibility = public` when Discovery is on). The `/app/events/new` seed (public, draft, Discovery off) is preserved.

## Control classification

| Control | Placement |
| --- | --- |
| Event type | Primary |
| Name, date, start/end time, time zone, venue, street, city, state, ZIP, short description | Primary |
| Event host (when a choice is required) | Primary (locked/studio-hosted hosts shown as text) |
| Runs more than one day / last day | Primary (single-day events submit end date = start date, which the server requires) |
| Registration required vs not needed, attendance limit, waitlist | Primary (competition: owned by Competition setup) |
| Who can find it, Discovery, publish now/draft | Primary |
| Web address (slug), address line 2, full description + AI assistant, cover image/URL, refund policy, FAQ | Advanced |
| Dance category/focus, beginner friendly, tags | Advanced |
| Account required, featured, registration opens/closes | Advanced (always mounted, so the "opens now" default still submits) |
| Multi-location schedule, agenda items, guest coaches | Advanced |
| Per-event ticket/pricing, rosters, settlement | Existing event detail surfaces (unchanged) |
