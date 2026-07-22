-- BUGFIX: edge functions write these tables via the service_role key.
-- service_role bypasses RLS but still needs table-level privileges. Tables
-- created via the MCP apply_migration path did NOT receive the standard
-- service_role grants, so submit-phase2's secondary writes 403'd
-- (permission denied) — and because those writes are warn-not-fail, the span
-- rows (phase2_output_classifications, since v11) and the new omission rows
-- silently never landed while the submission PATCH still succeeded.
--
-- Grant service_role full access (the Supabase convention) on all three
-- edge-function-written annotation tables.
GRANT ALL ON public.phase2_output_classifications TO service_role;
GRANT ALL ON public.output_omissions             TO service_role;
GRANT ALL ON public.output_omission_reviews      TO service_role;
