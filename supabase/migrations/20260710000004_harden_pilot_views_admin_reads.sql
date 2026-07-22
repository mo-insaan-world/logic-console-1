-- M4: Close the view-bypass leak + give admin read access to annotation tables.
--
-- The _pilot views were SECURITY DEFINER (security_invoker=off) with SELECT
-- granted to anon+authenticated, so they returned ALL rows regardless of the
-- base-table RLS added in M3 — a hostile authenticated user could read every
-- submission/rating through the view. Switch both to security_invoker=on so the
-- querying user's RLS applies, and revoke anon.
--
-- security_invoker=on means the reader must also pass RLS on the UNDERLYING
-- tables. submissions already has admin/self policies (M3); the annotation
-- tables were deny-all (service-role only), so admin (and phase2_union_ratings_
-- pilot) would see nothing. Add admin-only SELECT on the three annotation tables
-- — this is also what the admin panel's "all annotations" view needs. Surgeons
-- get NO direct read here; their writes still go through the service-role edge
-- functions (submit-phase2), unchanged.

-- ── harden the two remaining pilot views ─────────────────────────────────────
alter view public.submissions_pilot          set (security_invoker = on);
alter view public.phase2_union_ratings_pilot  set (security_invoker = on);
revoke all on public.submissions_pilot, public.phase2_union_ratings_pilot from anon;

-- ── admin read on annotation tables (needed by the view + admin panel) ───────
create policy pur_admin_read on public.phase2_union_ratings
  for select to authenticated using (public.is_admin(auth.uid()));
grant select on public.phase2_union_ratings to authenticated;

create policy poc_admin_read on public.phase2_output_classifications
  for select to authenticated using (public.is_admin(auth.uid()));
grant select on public.phase2_output_classifications to authenticated;

create policy oom_admin_read on public.output_omissions
  for select to authenticated using (public.is_admin(auth.uid()));
grant select on public.output_omissions to authenticated;

-- Defense-in-depth: revoke a stray pre-existing anon SELECT grant on
-- phase2_union_ratings. It was already neutralized (RLS has no anon policy, so
-- anon reads returned 0 rows), but revoking makes the posture unambiguous — anon
-- now gets a clean 401 rather than an empty 200.
revoke select on public.phase2_union_ratings from anon;
