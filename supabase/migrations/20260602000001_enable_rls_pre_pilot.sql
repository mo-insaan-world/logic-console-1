-- Pre-pilot RLS lockdown. Closes the rls_disabled_in_public Supabase
-- security alert on the seven public tables where RLS was off, and
-- tightens architect_cases + submissions per the agreed access matrix.
-- Edge functions use the service role and bypass RLS entirely; the
-- policies below govern ONLY the browser-side anon key paths.
--
-- KNOWN BROWSER BREAKAGE under this migration:
--   - architect_cases: anon UPDATE removed. Architect-submit's
--     difficulty-rating PATCH and admin approve/reject/delete will fail
--     until they move to a service-role edge function (or until a
--     column-scoped UPDATE policy is added back).
--   - submissions: anon UPDATE/DELETE never had a policy, so behaviour
--     unchanged at the policy level; the GRANTs are also revoked here
--     for defense-in-depth.

-- (1) Enable RLS on the seven tables flagged by the alert.
ALTER TABLE public.case_action_union                                              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase2_union_ratings                                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phase2_volunteered_lethal_actions                              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_sow_pre_specificity_case_action_union_2026_05_30      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_sow_pre_specificity_case_consensus_2026_05_30         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_sow_pre_specificity_case_scores_2026_05_30            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_sow_pre_specificity_model_responses_2026_05_30        ENABLE ROW LEVEL SECURITY;

-- (2) case_action_union: browser's Phase 2 cluster fetch goes through the
-- anon key, so anon needs SELECT. No anon WRITE — build-action-union
-- writes via service role.
CREATE POLICY "anon_select_case_action_union"
  ON public.case_action_union
  FOR SELECT TO anon
  USING (true);

-- (3) architect_cases: drop the permissive anon UPDATE policy. INSERT +
-- SELECT stay. See header for known breakage.
DROP POLICY IF EXISTS "Allow anon update" ON public.architect_cases;
REVOKE UPDATE, DELETE ON public.architect_cases FROM anon;

-- (4) submissions: anon never had an UPDATE policy; revoke the dormant
-- UPDATE/DELETE GRANTs so the surface attack is gone end-to-end.
REVOKE UPDATE, DELETE ON public.submissions FROM anon;

-- (5) phase2_union_ratings + phase2_volunteered_lethal_actions: deny-all
-- for anon. Browser never touches these directly; submit-phase2 writes
-- via service role. RLS enabled above with no policy = default-deny for
-- anon = correct.

-- (6) snapshot_* tables: archival, deny-all for anon. RLS enabled above
-- is sufficient.
