-- GC-1.2 rollback (lesson_transactions index artifact) -- net-new index,
-- no prior constraint to restore continuity with, so rollback is a
-- straightforward drop. Must run non-transactionally (CONCURRENTLY cannot
-- execute inside BEGIN/COMMIT).

drop index concurrently if exists public.uq_lesson_transactions_appointment_client_deduction;
