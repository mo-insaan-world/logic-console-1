-- M3: Flip the direct-browser tables from anon → authenticated, with row-level
-- ownership/admin gating. This closes the "anyone with the publishable key reads
-- all clinical data / edits any case body" exposure. Edge functions (service
-- role) are unaffected. specialist_registrations keeps its PUBLIC insert path.
--
-- Column-scoped editability is preserved exactly (same 7 columns that anon could
-- write), but now only the case's creator or an admin may write them, enforced
-- by RLS rather than obscurity.

-- ── architect_cases ──────────────────────────────────────────────────────────
drop policy if exists "Allow anon select"                      on public.architect_cases;
drop policy if exists "Allow anon insert"                      on public.architect_cases;
drop policy if exists "anon_update_architect_cases_meta_only"  on public.architect_cases;
revoke all on public.architect_cases from anon;

-- Read: every authenticated expert sees all cases (preserves the prior
-- USING(true) visibility, now auth-gated). Admin included.
create policy ac_auth_read on public.architect_cases
  for select to authenticated using (true);

-- Insert: author your own case (created_by defaults to auth.uid()); admin any.
create policy ac_auth_insert on public.architect_cases
  for insert to authenticated
  with check (created_by = auth.uid() or public.is_admin(auth.uid()));

-- Update: only the creator or an admin, and only the same metadata/body columns
-- anon could write before (service-managed columns stay off-limits via the
-- column-scoped GRANT below).
create policy ac_auth_update on public.architect_cases
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin(auth.uid()))
  with check (created_by = auth.uid() or public.is_admin(auth.uid()));

grant select, insert on public.architect_cases to authenticated;
grant update (difficulty_rating, difficulty_assessment, status,
              scenario_json, vitals_json, constraints_json, case_title)
  on public.architect_cases to authenticated;

-- ── submissions ──────────────────────────────────────────────────────────────
drop policy if exists "Allow anon select" on public.submissions;
drop policy if exists "Allow anon insert" on public.submissions;
revoke all on public.submissions from anon;

-- Read own rows; admin reads all.
create policy sub_auth_read on public.submissions
  for select to authenticated
  using (annotator_id = auth.uid() or public.is_admin(auth.uid()));

-- Insert only attributed to self (annotator_id defaults to auth.uid()).
create policy sub_auth_insert on public.submissions
  for insert to authenticated
  with check (annotator_id = auth.uid());

grant select, insert on public.submissions to authenticated;

-- ── case_action_union ────────────────────────────────────────────────────────
drop policy if exists "anon_select_case_action_union" on public.case_action_union;
revoke all on public.case_action_union from anon;
create policy cau_auth_read on public.case_action_union
  for select to authenticated using (true);
grant select on public.case_action_union to authenticated;

-- ── specialist_registrations ─────────────────────────────────────────────────
-- Keep the PUBLIC "register interest" insert path untouched (marketing form).
-- Add admin-only SELECT so the experts panel can list submissions. RLS gates
-- rows to admin; the grant only opens the table to the authenticated role.
create policy specreg_admin_read on public.specialist_registrations
  for select to authenticated using (public.is_admin(auth.uid()));
grant select on public.specialist_registrations to authenticated;
