-- ARIA Operations generated actions use ARIA-specific rule keys.
-- This migration expands existing automation rule/action/run constraints so those
-- generated operational actions can be persisted and audited.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'automation_rules'
      AND constraint_name = 'automation_rules_rule_key_check'
  ) THEN
    ALTER TABLE public.automation_rules
      DROP CONSTRAINT automation_rules_rule_key_check;
  END IF;

  ALTER TABLE public.automation_rules
    ADD CONSTRAINT automation_rules_rule_key_check
    CHECK (
      rule_key IN (
        'low_package_balance',
        'no_upcoming_lesson',
        'unsigned_document',
        'pending_booking_request',
        'first_lesson_follow_up',
        'aria_payment_exception',
        'aria_membership_past_due',
        'aria_membership_canceling',
        'aria_booking_request_aging',
        'aria_low_package_balance',
        'aria_stale_active_student',
        'aria_intro_no_purchase',
        'aria_event_unpaid_registration',
        'aria_event_loss',
        'aria_event_missing_costs',
        'aria_event_low_checkin'
      )
    );
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'automation_actions'
      AND constraint_name = 'automation_actions_rule_key_check'
  ) THEN
    ALTER TABLE public.automation_actions
      DROP CONSTRAINT automation_actions_rule_key_check;

    ALTER TABLE public.automation_actions
      ADD CONSTRAINT automation_actions_rule_key_check
      CHECK (
        rule_key IN (
          'low_package_balance',
          'no_upcoming_lesson',
          'unsigned_document',
          'pending_booking_request',
          'first_lesson_follow_up',
          'aria_payment_exception',
          'aria_membership_past_due',
          'aria_membership_canceling',
          'aria_booking_request_aging',
          'aria_low_package_balance',
          'aria_stale_active_student',
          'aria_intro_no_purchase',
          'aria_event_unpaid_registration',
          'aria_event_loss',
          'aria_event_missing_costs',
          'aria_event_low_checkin'
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'automation_runs'
      AND constraint_name = 'automation_runs_rule_key_check'
  ) THEN
    ALTER TABLE public.automation_runs
      DROP CONSTRAINT automation_runs_rule_key_check;

    ALTER TABLE public.automation_runs
      ADD CONSTRAINT automation_runs_rule_key_check
      CHECK (
        rule_key IN (
          'low_package_balance',
          'no_upcoming_lesson',
          'unsigned_document',
          'pending_booking_request',
          'first_lesson_follow_up',
          'aria_payment_exception',
          'aria_membership_past_due',
          'aria_membership_canceling',
          'aria_booking_request_aging',
          'aria_low_package_balance',
          'aria_stale_active_student',
          'aria_intro_no_purchase',
          'aria_event_unpaid_registration',
          'aria_event_loss',
          'aria_event_missing_costs',
          'aria_event_low_checkin'
        )
      );
  END IF;
END $$;
