-- DanceFlow Studio Curriculum V2 - Style/Dance Classification Correction
-- Allows the same dance name to exist independently under multiple styles.
-- This migration does not move existing records automatically because Cha Cha,
-- East Coast Swing, and West Coast Swing require studio-specific classification.

-- The existing constraint is already scoped to style_id:
-- unique (style_id, name)
-- This validation block documents and verifies that no global dance-name
-- uniqueness constraint prevents style-specific copies.

do $$
declare
  global_name_constraint text;
begin
  select conname
    into global_name_constraint
  from pg_constraint
  where conrelid = 'public.syllabus_dances'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (name)'
  limit 1;

  if global_name_constraint is not null then
    execute format(
      'alter table public.syllabus_dances drop constraint %I',
      global_name_constraint
    );
  end if;
end
$$;

-- Studios may now create, for example:
-- Country -> Cha Cha
-- Ballroom -> Cha Cha
-- Country -> East Coast Swing
-- Ballroom -> East Coast Swing
-- without merging those curriculum branches.
