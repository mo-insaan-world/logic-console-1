-- Restore architect_cases anon UPDATE — column-scoped. After the
-- enable_rls_pre_pilot migration, anon UPDATE was dropped entirely, which
-- broke (a) submitArchitectCase's post-INSERT PATCH that writes
-- difficulty_rating + difficulty_assessment, and (b) the admin-view
-- approve/reject PATCH on status. Both legitimate paths.
--
-- Body content (scenario_json, vitals_json, constraints_json,
-- architect_ground_truth) MUST stay immutable to anon — tampering with
-- those would defeat the case-authoring authenticity guarantee. So the
-- GRANT is column-scoped: only the three metadata columns are writable
-- by anon. Attempting a PATCH against any other column returns 401
-- (Postgres permission-denied 42501).
--
-- DELETE remains blocked. Admin delete from the browser will fail until
-- it moves to a service-role edge function (separate change).

CREATE POLICY "anon_update_architect_cases_meta_only"
  ON public.architect_cases
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);

GRANT UPDATE (difficulty_rating, difficulty_assessment, status)
  ON public.architect_cases
  TO anon;
