# ARIA Autonomy Preference Model — Slice 6.2

The three recommended setup preferences now expose the full autonomy ladder:

- Handle automatically
- Prepare for my review
- Notify me only
- Off

“Handle automatically” means maximum safe autonomy allowed by the rules inside that operational area. It never grants broader permission than the underlying rule supports.

Front Desk automatic mode may only execute actions whose rules explicitly permit automation. Schedule changes and judgment-heavy work remain review-only.

Marketing automatic mode may identify and prepare opportunities automatically, but campaign sending still requires explicit rule-level send permission.

Billing & Payments automatic mode may handle only safe communication or internal work already permitted by the underlying rule. It still cannot charge, retry, refund, waive, change access, or mark external payments paid automatically.

Persistence continues to use the existing `aria_automation_pack_preferences.settings` JSON.

`off` also sets the pack's `enabled` field to false and disables the pack's existing `automation_rules`.

No database migration is required.
