alter table public.appointments
add column if not exists billing_type text not null default 'package_credit';

alter table public.appointments
add column if not exists billing_note text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'appointments_billing_type_check'
  ) then
    alter table public.appointments
    add constraint appointments_billing_type_check
    check (
      billing_type in (
        'package_credit',
        'membership',
        'pay_as_you_go',
        'free_comped'
      )
    );
  end if;
end $$;
