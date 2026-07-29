-- ARIA expanded operational runtime coverage.
-- Run after 20260729000200_aria_operational_pack_preferences_v1.sql
-- and before deploying Slice 5 application code.

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'automation_rules'
      and constraint_name = 'automation_rules_rule_key_check'
  ) then
    alter table public.automation_rules
      drop constraint automation_rules_rule_key_check;
  end if;

  alter table public.automation_rules
    add constraint automation_rules_rule_key_check
    check (
      rule_key in (
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
          'aria_package_expiring',
          'aria_stale_active_student',
          'aria_intro_no_purchase',
          'aria_event_unpaid_registration',
          'aria_event_loss',
          'aria_event_missing_costs',
          'aria_event_low_checkin',
          'aria_appointment_confirmation_gap',
          'aria_no_show_service_recovery',
          'aria_schedule_conflict',
          'aria_marketing_opportunity',
          'aria_payroll_missing_data',
          'aria_inventory_low_stock',
          'aria_data_quality_exception'
      )
    );
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'automation_actions'
      and constraint_name = 'automation_actions_rule_key_check'
  ) then
    alter table public.automation_actions
      drop constraint automation_actions_rule_key_check;

    alter table public.automation_actions
      add constraint automation_actions_rule_key_check
      check (
        rule_key in (
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
          'aria_package_expiring',
          'aria_stale_active_student',
          'aria_intro_no_purchase',
          'aria_event_unpaid_registration',
          'aria_event_loss',
          'aria_event_missing_costs',
          'aria_event_low_checkin',
          'aria_appointment_confirmation_gap',
          'aria_no_show_service_recovery',
          'aria_schedule_conflict',
          'aria_marketing_opportunity',
          'aria_payroll_missing_data',
          'aria_inventory_low_stock',
          'aria_data_quality_exception'
        )
      );
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'automation_runs'
      and constraint_name = 'automation_runs_rule_key_check'
  ) then
    alter table public.automation_runs
      drop constraint automation_runs_rule_key_check;

    alter table public.automation_runs
      add constraint automation_runs_rule_key_check
      check (
        rule_key in (
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
          'aria_package_expiring',
          'aria_stale_active_student',
          'aria_intro_no_purchase',
          'aria_event_unpaid_registration',
          'aria_event_loss',
          'aria_event_missing_costs',
          'aria_event_low_checkin',
          'aria_appointment_confirmation_gap',
          'aria_no_show_service_recovery',
          'aria_schedule_conflict',
          'aria_marketing_opportunity',
          'aria_payroll_missing_data',
          'aria_inventory_low_stock',
          'aria_data_quality_exception'
        )
      );
  end if;
end $$;
