# DRAFT combined notice template (NOT APPROVED, NOT FOR SENDING)

**Status: draft wording for owner and legal review only.** Nothing in this file has been approved or sent. Every `{{placeholder}}` must be filled from a record at render time; a renderer must refuse to produce output when any placeholder is empty, and must never substitute a default. Bracketed `[LEGAL: ...]` items are reserved for legal text the repo does not contain.

Related: `docs/billing/D7-WP5-NOTICE-PLAN.md`, `docs/billing/D7-RELEASE-READINESS.md` 8.5.C.

## Placeholders

| Placeholder | Source record | Status |
|---|---|---|
| `{{studio_name}}` | `studios.name` | from record |
| `{{recipient_name}}` | owner profile | from record |
| `{{current_price}}` | the subscription's current price (cents, formatted) | from record |
| `{{new_price}}` | `price_transition_notices.new_unit_amount_cents` with `currency` | from the notice row; owner-approved before the row is created |
| `{{new_price_interval}}` | `price_transition_notices.billing_interval` | from record |
| `{{price_effective_date}}` | `price_transition_notices.effective_at`, rendered in the studio time zone and UTC | from record; verified billing boundary |
| `{{suite_end_instant_local}}`, `{{suite_end_instant_utc}}` | `entitlementEndInstant(period_end, studios.timezone)` | from record |
| `{{addon_price}}` / `{{addon_interval}}` | approved add-on price record (WP-4) | **UNAPPROVED, NEEDS OWNER INPUT** |
| `{{post_expiry_visibility}}` | owner decision G11 | **NEEDS OWNER INPUT** |
| `{{billing_page_url}}` | app billing page URL | from configuration |
| `{{contact_route}}` | support contact | **NEEDS OWNER INPUT** |
| `{{terms_reference}}` | Terms section on price changes | from configuration |
| `{{notice_kind}}` | initial / 30-day reminder / 7-day reminder / ended | reminders and the ended notice are placeholders needing owner approval |
| `{{notice_sent_date}}` | set at send time | system |

## Subject
`Changes to your DanceFlow plan and Organizer Suite access on {{price_effective_date}}`

## Body

Hello {{recipient_name}},

This is a notice about two changes to {{studio_name}}'s DanceFlow account. Nothing is purchased or charged because of this message. Both changes are described below with the exact amounts and dates.

**1. Your plan price will change on {{price_effective_date}}**

Your current price is {{current_price}} per {{new_price_interval}}. Starting on {{price_effective_date}}, your price will be {{new_price}} per {{new_price_interval}}. This is the price that applies to your plan from that date.

**2. Your complimentary Organizer Suite access ends on {{suite_end_instant_local}} ({{suite_end_instant_utc}})**

Organizer Suite has been included with your plan at no additional charge. That complimentary access ends at the time shown above. After that time, Organizer Suite is available only as a paid add-on, {{addon_price}} per {{addon_interval}}. If the add-on is not active when the complimentary access ends, Organizer Suite access stops.

**What you need to do**

- To keep Organizer Suite, you can add it yourself on your billing page: {{billing_page_url}}. We will not add it or charge for it for you, and your access will not be extended automatically.
- If you do nothing, your plan price changes as described in section 1, and Organizer Suite access ends as described in section 2. You are not charged for the add-on.

**What stays the same**

- Your data stays in your account. Completed bookings, paid orders and registrations remain valid and are not cancelled or refunded because of this change.
- After Organizer Suite access ends, {{post_expiry_visibility}}.

**What stops when Organizer Suite access ends**

New ticket sales, in-person and card-reader sales, marking registrations paid, new event registrations and the other Organizer Suite tools for events you run as an organizer.

**Questions**

Contact us at {{contact_route}}. Billing terms: {{terms_reference}}. [LEGAL: any additional statutory or contractual notice text]

{{studio_name}} was sent this message on {{notice_sent_date}}.

## Reminder and closing variants (placeholders, NEEDS OWNER APPROVAL)

- **30-day reminder / 7-day reminder (`{{notice_kind}}`)**: same body with the first sentence replaced by "This is a reminder that the changes described in our notice of {{original_notice_date}} take effect on {{price_effective_date}}." Suppress the Suite sections when a paid add-on is already active and state only the price change.
- **Access ended**: "Complimentary Organizer Suite access for {{studio_name}} ended on {{suite_end_instant_local}}. To restore access, add Organizer Suite on your billing page: {{billing_page_url}}. Your data is preserved." Sent only if no current paid add-on exists.
