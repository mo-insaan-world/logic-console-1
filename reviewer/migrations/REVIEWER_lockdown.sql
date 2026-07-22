-- REVIEWER_lockdown.sql — APPLY ONLY TO THE REVIEWER PROJECT, never production.
--
-- Production grants anon INSERT/SELECT/UPDATE on `submissions` and
-- `architect_cases` (the app writes them via direct REST with the anon key).
-- On the reviewer instance we DROP those anon policies so that the anon key
-- ALONE can read or write NOTHING — every data path then goes through a
-- token-gated service-role edge function (reviewer-data / submit-phase2 /
-- phase2-model-outputs). RLS stays ON; with no anon policy, anon REST is denied
-- by default. (model_responses, phase2_output_classifications, output_omissions
-- already have no anon policy, so they need no change.)
--
-- Idempotent: safe to re-run.

DROP POLICY IF EXISTS "Allow anon insert"                       ON public.submissions;
DROP POLICY IF EXISTS "Allow anon select"                       ON public.submissions;

DROP POLICY IF EXISTS "Allow anon insert"                       ON public.architect_cases;
DROP POLICY IF EXISTS "Allow anon select"                       ON public.architect_cases;
DROP POLICY IF EXISTS "anon_update_architect_cases_meta_only"   ON public.architect_cases;

-- Belt-and-braces: ensure RLS remains enabled (default-deny once policies gone).
ALTER TABLE public.submissions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_cases ENABLE ROW LEVEL SECURITY;

-- Verify (run manually after applying): each should return 0 anon policies.
--   select polname from pg_policy
--     where polrelid='public.submissions'::regclass
--       and 'anon'=any(polroles::regrole[]::text[]);
