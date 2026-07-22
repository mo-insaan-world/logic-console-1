-- Expand the column-scoped anon UPDATE grant on architect_cases to include
-- the body jsonb columns (scenario_json, vitals_json, constraints_json) so
-- the admin Edit Case form can PATCH them in-browser.
--
-- SCOPE: pilot / accepted trade-off.
-- The 2026-06-02 RLS lockdown migration deliberately blocked anon PATCH on
-- these body columns to prevent tampering-by-URL. That guarantee is being
-- relaxed here so the admin's in-browser Edit Case workflow can mutate
-- case content (history / examination / working_diagnosis / vitals /
-- constraints) directly. The trade-off is conscious:
--
--   - "Admin" is currently just a URL-accessible view mode, not a real
--     authenticated role. Any client that knows architect_cases UUIDs
--     can now tamper with their content.
--   - The pilot audience is trusted; the deployed URL is not advertised
--     to anyone outside the pilot.
--   - The alternative (route every edit through a service-role edge
--     function with FUNCTION_INVOKE_SECRET, mirroring admin-delete-case)
--     would force the admin through copy-the-curl friction for every
--     text edit — unusable for the Edit Case workflow's intended UX.
--
-- POST-PILOT FIX: introduce real Supabase auth roles for admin, switch
-- the admin view to require authenticated sessions, REVOKE these
-- column grants and route admin mutations through a session-gated edge
-- function. Until then, this is the pragmatic minimum.

GRANT UPDATE (scenario_json, vitals_json, constraints_json)
  ON public.architect_cases
  TO anon;
