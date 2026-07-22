-- ── Phase 2 open-elicitation: "other lethal actions under these constraints" ──
--
-- Captures consultant-volunteered lethal-action candidates entered in the
-- single multi-line textarea below the SoC step ratings on the Phase 2
-- attestation panel. One row per non-empty newline-split entry.
--
-- DURABILITY: the raw array is ALSO persisted on
-- submissions.phase2_step_ratings_json under the top-level key
-- `volunteered_lethal_actions`, written atomically in the same PATCH that
-- saves the per-step ratings. The dedicated table here is a denormalized
-- queryable index over that JSONB. If the secondary INSERT into this table
-- fails after the primary PATCH succeeds, no data is lost — rows can be
-- re-derived from the JSONB. Reconciliation predicate:
--
--   SELECT s.id, s.phase2_step_ratings_json -> 'volunteered_lethal_actions'
--   FROM   public.submissions s
--   WHERE  jsonb_array_length(s.phase2_step_ratings_json -> 'volunteered_lethal_actions') > 0
--     AND  NOT EXISTS (
--            SELECT 1 FROM public.phase2_volunteered_lethal_actions v
--            WHERE  v.phase2_submission_id = s.id
--          );
--
-- SCOPING: storage only. As of 2026-05-28 these rows do NOT feed scoring or
-- the safety gate — the closed-world scoring surface still derives
-- exclusively from the architect-verified static_textbook_protocol. This
-- table is the queryable substrate for a future captured-lethal-set analysis
-- across the consultant cohort for a given case (parallel to, not bolted
-- onto, the architect-verified SoC reference).
--
-- LEGACY CRITIQUE PRESERVATION: the per-step `critique` key inside
-- phase2_step_ratings_json.ratings[] and the aggregate
-- adversarial_critique_trace column are intentionally NOT dropped by this
-- migration. 7 real (non-synthetic) consultant submissions across
-- BRH-2024-0774, BRH-2024-0891, JHB-2024-2201 carry historical critique
-- text written before this change. The UI stops collecting critiques as of
-- this commit, but the columns are preserved so historical data is not
-- lost. Future submissions write neither.

CREATE TABLE IF NOT EXISTS public.phase2_volunteered_lethal_actions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phase2_submission_id  uuid        NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  case_id               text        NOT NULL,
  consultant_id         text        NULL,
  action_text           text        NOT NULL
                                    CHECK (length(trim(action_text)) > 0 AND length(action_text) <= 1000),
  source                text        NOT NULL DEFAULT 'consultant_volunteered'
                                    CHECK (source IN ('consultant_volunteered')),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phase2_vol_lethal_case_idx
  ON public.phase2_volunteered_lethal_actions (case_id);
CREATE INDEX IF NOT EXISTS phase2_vol_lethal_consultant_idx
  ON public.phase2_volunteered_lethal_actions (consultant_id)
  WHERE consultant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS phase2_vol_lethal_submission_idx
  ON public.phase2_volunteered_lethal_actions (phase2_submission_id);

COMMENT ON TABLE public.phase2_volunteered_lethal_actions IS
  'Open-elicitation: consultant-volunteered "other lethal actions under these constraints" captured in a single textarea below the Phase 2 SoC step ratings. One row per non-empty newline-split entry. Source-tagged for future widening of the provenance set. Raw array also lives on submissions.phase2_step_ratings_json.volunteered_lethal_actions (atomic with the ratings PATCH); this table is a denormalized index for cohort queries.';
COMMENT ON COLUMN public.phase2_volunteered_lethal_actions.consultant_id IS
  'NULL today — the submissions table carries no annotator-identity column, so there is nothing to populate at insert time. Column reserved for a future consultant-identity migration that adds annotator identity consistently across the consultant write surface.';
COMMENT ON COLUMN public.phase2_volunteered_lethal_actions.source IS
  'Provenance tag. Today only consultant_volunteered. Future values may include expert_adjudicated or auto_extracted; widen the CHECK constraint when adding.';

-- ── Passive count instrumentation on submissions ────────────────────────────
-- Mirrors phase2_duration_ms — same passive-measurement principle. Captured
-- server-side from the validated array length (client value ignored to
-- prevent drift between the count and the actual rows).
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS phase2_volunteered_lethal_count integer;

COMMENT ON COLUMN public.submissions.phase2_volunteered_lethal_count IS
  'Count of non-empty newline-split lines volunteered by the consultant in the Phase 2 "other lethal actions under these constraints" field at submit time. 0 when nothing volunteered (the field is fully optional and blank submission is expected). Passive engagement signal — consultant never sees this number. Per-consultant trends help spot rubber-stamping (always 0 across many sessions) versus engaged review (occasional 1-3). Derived server-side from the validated array length; NOT a count of rows in phase2_volunteered_lethal_actions (the dedicated table can lag if a secondary INSERT failed — see migration header comment for the reconciliation predicate).';

GRANT SELECT, INSERT ON public.phase2_volunteered_lethal_actions TO service_role;
-- No GRANTs to anon — writes route exclusively through the submit-phase2
-- edge function (service-role tier). Same pattern as submissions.
