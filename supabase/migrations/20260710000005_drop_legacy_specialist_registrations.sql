-- M5: Drop the legacy, empty, unused specialist_registrations table.
--
-- Rationale (see the M3 report): this table is empty, referenced by NO app code
-- and NO prior migration, and has no INSERT grant on any API role — so its
-- "Anyone can register interest" policy was always inert. The live registration-
-- interest form on insaan.world writes to the separate `medicine-registrations`
-- Supabase project. This is a stray shell; the admin experts panel will use a
-- manual "Add expert" form only (decision (a), 2026-07-10).
--
-- SAFETY GUARD: refuse to drop if the table somehow contains rows, so this can
-- never silently destroy data. Dropping cascades the two policies + admin grant
-- added earlier; that is intended.

do $$
declare n bigint;
begin
  if exists (select 1 from information_schema.tables
             where table_schema='public' and table_name='specialist_registrations') then
    execute 'select count(*) from public.specialist_registrations' into n;
    if n > 0 then
      raise exception 'refusing to drop specialist_registrations: % row(s) present', n;
    end if;
    drop table public.specialist_registrations;
  end if;
end $$;
