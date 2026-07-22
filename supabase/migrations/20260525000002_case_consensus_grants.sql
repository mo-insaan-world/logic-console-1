-- Service-role access to case_consensus. The score-responses Edge Function
-- uses SUPABASE_SERVICE_ROLE_KEY, which the API gateway proxies as the
-- service_role Postgres role. service_role does not bypass RLS through the
-- REST API (unlike a direct service-role connection), so it needs explicit
-- GRANTs on the table. Matches the grant pattern of case_scores.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_consensus TO service_role;
