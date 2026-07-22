-- Extend the admin column-scope UPDATE grant to include case_title.
--
-- The 20260603000001 migration added scenario_json/vitals_json/
-- constraints_json so the admin Edit Case PATCH can mutate body content.
-- But the admin form ALSO mutates case_title (the title chip in the
-- editable case header), and PostgREST rejects the WHOLE PATCH with 401
-- when any column in the payload lacks UPDATE permission — meaning the
-- admin form silently 401'd every save until case_title was either
-- removed from the payload or granted here. case_title is metadata-
-- class (sibling of status/difficulty), not body content; granting it
-- is consistent with the column-scope intent.

GRANT UPDATE (case_title) ON public.architect_cases TO anon;
