-- Drop the persistence of the removed "other lethal actions" open-elicitation
-- field. The field was removed from the app + submit-phase2 on 2026-06-20
-- (superseded by the per-output omission check; see commit a547d26).
--
-- Confirmed safe to drop: phase2_volunteered_lethal_actions held 0 rows,
-- submissions.phase2_volunteered_lethal_count was always 0, there is no
-- historical data and no retention concern. No code reads any of these
-- objects; submit-phase2 is redeployed to stop writing the count column
-- BEFORE this migration runs.
--
-- Dependency note (caught in STEP 0): the column is referenced by the
-- submissions_pilot view (explicit column list); that view in turn has two
-- dependents — phase2_union_ratings_pilot and phase2_volunteered_lethal_actions
-- _pilot — and the latter also depends on the table. Handled here:
--   * phase2_volunteered_lethal_actions_pilot → dropped outright (its source
--     table is going away).
--   * submissions_pilot → recreated identically minus the dropped column.
--   * phase2_union_ratings_pilot → dropped then recreated verbatim (it does
--     not reference the dropped column; it just joins submissions_pilot).
-- All views re-granted SELECT to anon, authenticated (their prior grant).

-- 1. Drop the two dependents of submissions_pilot.
DROP VIEW IF EXISTS public.phase2_volunteered_lethal_actions_pilot;   -- gone for good
DROP VIEW IF EXISTS public.phase2_union_ratings_pilot;                 -- recreated below

-- 2. Drop submissions_pilot (depends on the column); recreated below.
DROP VIEW IF EXISTS public.submissions_pilot;

-- 3. Drop the dedicated table (0 rows, no FKs reference it).
DROP TABLE IF EXISTS public.phase2_volunteered_lethal_actions;

-- 4. Drop the count column from submissions.
ALTER TABLE public.submissions DROP COLUMN IF EXISTS phase2_volunteered_lethal_count;

-- 5. Recreate submissions_pilot WITHOUT phase2_volunteered_lethal_count.
--    Column list + WHERE clause reproduced verbatim from the live definition,
--    minus the dropped column. Grants restored to match the prior view.
CREATE VIEW public.submissions_pilot AS
  SELECT id,
         created_at,
         case_id,
         view_mode,
         decision,
         selected_alternative,
         reasoning_json,
         resilience_score,
         constraint_snapshot,
         time_to_decision_seconds,
         phase2_step_ratings_json,
         ai_safety_rating,
         adversarial_critique_trace,
         standard_of_care_steps,
         phase2_completed_at,
         action_trace,
         phase1_duration_ms,
         phase2_duration_ms,
         total_session_duration_ms,
         action_trace_char_count,
         action_trace_word_count,
         reasoning_trace_char_count,
         reasoning_trace_word_count,
         confirmed_atom_count,
         atom_mean_word_length,
         constraint_tagged_atom_count,
         decline_count,
         consultant_id
    FROM public.submissions
   WHERE consultant_id IS NOT NULL
     AND consultant_id NOT LIKE '%TEST%'
     AND consultant_id NOT LIKE '%MACHINERY%';

GRANT SELECT ON public.submissions_pilot TO anon, authenticated;

-- 6. Recreate phase2_union_ratings_pilot verbatim (joins the rebuilt
--    submissions_pilot; does not reference the dropped column).
CREATE VIEW public.phase2_union_ratings_pilot AS
  SELECT r.id,
         r.submission_id,
         r.case_id,
         r.cluster_id,
         r.rating,
         r.rated_at,
         r.synthetic
    FROM public.phase2_union_ratings r
    JOIN public.submissions_pilot s ON r.submission_id = s.id;

GRANT SELECT ON public.phase2_union_ratings_pilot TO anon, authenticated;
