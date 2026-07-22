-- ── Phase 2 union redesign — case_action_union + phase2_union_ratings ──────
--
-- Replaces the consultant-facing object in Phase 2: instead of rating the
-- architect-verified IDEAL standard-of-care guideline under the case's
-- constraints, the consultant now rates the deduplicated UNION of all
-- construction-set models' actions for the case. Same rating vocabulary
-- (LETHAL / SUB-OPTIMAL / ACCEPTABLE), same Phase 1, same open-elicitation
-- field. The object being rated is what changes.
--
-- ── FREEZE SEMANTICS (load-bearing) ───────────────────────────────────────
--
-- The union for a case is BUILT ONCE and FROZEN thereafter. Adding new
-- models-under-test (MUTs) to model_responses does NOT trigger a rebuild
-- and does NOT invalidate any consultant's ratings. The construction set
-- is implicitly defined by which models had successful responses at FIRST
-- BUILD TIME for the case; this set is recorded in
-- case_action_union.construction_set (text[]) per-row for audit.
--
-- The build endpoint (supabase/functions/build-action-union) defaults to
-- REFUSE-REBUILD: a second invocation for a case with an existing union
-- returns 409 with the existing union metadata. A deliberate rebuild
-- requires `?force_rebuild=true` in the body, which:
--   1. DELETEs all case_action_union rows for the case_id
--   2. The FK ON DELETE CASCADE below propagates to phase2_union_ratings,
--      invalidating all prior consultant ratings for the case
--   3. Re-runs extractAtomicActions + clusterEquivalentActions
--   4. Returns a loud warning in the response payload
--
-- This protects the benchmark from accidentally re-paying consultants every
-- time a new MUT is added. New MUTs are scored AGAINST the frozen union
-- via the judge ensemble (existing infrastructure: per-cluster presence
-- judging on canonical_action). The scoring-integration change that
-- implements this is SEPARATE — this migration only stores the data.
--
-- Future deliberate benchmark version bumps (v1 → v2) would explicitly
-- force_rebuild per case. A benchmark_version table abstraction can be
-- added when v2 is actually needed; for v1 explicit per-case force_rebuild
-- is enough discipline.
--
-- ── COLUMN-CONTRACT BRIDGE (no scoring code changes this pass) ────────────
--
-- The scoring path (score-responses + scoring.ts) consumes
-- submissions.ai_safety_rating today as a case-level worst-of-all-consultant-
-- ratings signal. Under the new flow, submit-phase2 continues to write
-- ai_safety_rating as worst-across-the-consultant's-union-ratings. The
-- column's contract is preserved; scoring works byte-for-byte unmodified.
-- The semantic source shifts from "worst SoC step rating" to "worst union
-- action rating" — documented in code comments. The next scoring-
-- integration change refactors to per-model gating using the
-- (case_action_union.contributing_models × phase2_union_ratings.rating)
-- JOIN; that's deferred.
--
-- ── OLD STORAGE PRESERVATION ──────────────────────────────────────────────
--
-- This migration does NOT drop:
--   - architect_cases.static_textbook_protocol (the old SoC reference)
--   - submissions.standard_of_care_steps (per-submission SoC snapshot)
--   - submissions.phase2_step_ratings_json.ratings key (old per-step ratings)
--
-- All three become dormant for new submissions but historical data is
-- preserved. The volunteered_lethal_actions key on phase2_step_ratings_json
-- and its companion phase2_volunteered_lethal_actions table are also
-- unchanged — the open-elicitation field continues to function identically.

-- ── case_action_union: one row per deduplicated action per case ───────────
CREATE TABLE IF NOT EXISTS public.case_action_union (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id               text        NOT NULL,
  cluster_index         integer     NOT NULL,
  canonical_action      text        NOT NULL
                                    CHECK (length(trim(canonical_action)) > 0),
  contributing_models   text[]      NOT NULL
                                    CHECK (array_length(contributing_models, 1) >= 1),
  member_atoms          jsonb       NOT NULL,
  construction_set      text[]      NOT NULL
                                    CHECK (array_length(construction_set, 1) >= 1),
  display_order         integer     NOT NULL,
  built_at              timestamptz NOT NULL DEFAULT now(),
  built_by              text        NOT NULL,
  synthetic             boolean     NOT NULL DEFAULT false,
  UNIQUE (case_id, cluster_index)
);

CREATE INDEX IF NOT EXISTS case_action_union_case_idx
  ON public.case_action_union (case_id);
CREATE INDEX IF NOT EXISTS case_action_union_case_order_idx
  ON public.case_action_union (case_id, display_order);

COMMENT ON TABLE public.case_action_union IS
  'Deduplicated union of all construction-set models'' actions for a case, one row per cluster. Built once via build-action-union edge function, FROZEN thereafter unless force_rebuild=true (which cascades-deletes phase2_union_ratings). Consultants rate these clusters; rating propagates to every model in contributing_models. construction_set captures which models contributed at build time (load-bearing for the "X of N support" UI display). member_atoms preserves the raw per-model atom text for audit.';
COMMENT ON COLUMN public.case_action_union.contributing_models IS
  'Models whose atoms were merged into this cluster. Subset of construction_set. The "X" in the consultant-facing "Recommended by X of N" support count.';
COMMENT ON COLUMN public.case_action_union.construction_set IS
  'All models that had successful responses at first-build time for this case. Same value across every row for a given case (denormalised for query simplicity). The "N" in "Recommended by X of N".';
COMMENT ON COLUMN public.case_action_union.member_atoms IS
  'JSONB array of {model: text, atom_text: text} entries. Preserves the verbatim per-model atom that fed this cluster. Audit only; not displayed to consultants.';
COMMENT ON COLUMN public.case_action_union.built_by IS
  'Identifier of the build pass — e.g. "build-action-union/v1". Useful for forensic replay when an extractor or clusterer prompt evolves and we need to know which build a given union came from.';

-- ── phase2_union_ratings: per-consultant per-cluster rating ───────────────
CREATE TABLE IF NOT EXISTS public.phase2_union_ratings (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id         uuid        NOT NULL REFERENCES public.submissions(id) ON DELETE CASCADE,
  case_id               text        NOT NULL,
  cluster_id            uuid        NOT NULL REFERENCES public.case_action_union(id) ON DELETE CASCADE,
  rating                text        NOT NULL
                                    CHECK (rating IN ('acceptable', 'sub_optimal', 'lethal')),
  rated_at              timestamptz NOT NULL DEFAULT now(),
  synthetic             boolean     NOT NULL DEFAULT false,
  UNIQUE (submission_id, cluster_id)
);

CREATE INDEX IF NOT EXISTS phase2_union_ratings_submission_idx
  ON public.phase2_union_ratings (submission_id);
CREATE INDEX IF NOT EXISTS phase2_union_ratings_cluster_idx
  ON public.phase2_union_ratings (cluster_id);
CREATE INDEX IF NOT EXISTS phase2_union_ratings_case_idx
  ON public.phase2_union_ratings (case_id);
CREATE INDEX IF NOT EXISTS phase2_union_ratings_case_lethal_idx
  ON public.phase2_union_ratings (case_id, cluster_id)
  WHERE rating = 'lethal';

COMMENT ON TABLE public.phase2_union_ratings IS
  'Per-consultant per-cluster Phase 2 rating. Replaces the role of submissions.phase2_step_ratings_json.ratings for the new union flow. The volunteered_lethal_actions array stays on phase2_step_ratings_json (it''s per-submission, not per-cluster, so the JSONB shape continues to serve it). For scoring lookup "did model M get rated LETHAL on case C", JOIN against case_action_union.contributing_models — see the migration header comment for the predicate.';
COMMENT ON COLUMN public.phase2_union_ratings.rating IS
  'Vocabulary unchanged from old per-step ratings: acceptable / sub_optimal / lethal. The check constraint matches the old phase2_step_ratings_json.ratings[].rating allowed values exactly.';

-- ── Grants ────────────────────────────────────────────────────────────────
-- Reads: anon + authenticated (consultant UI fetches the union to render;
-- admin UI reads ratings for the annotations dashboard). Same pattern as
-- case_consensus + submissions reads.
-- Writes: service_role only (via build-action-union and submit-phase2 edge
-- functions — both use FUNCTION_INVOKE_SECRET or anon-tier auth respectively
-- and call into the service role internally).
GRANT SELECT ON public.case_action_union     TO anon, authenticated;
GRANT SELECT ON public.phase2_union_ratings  TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.case_action_union    TO service_role;
GRANT SELECT, INSERT, DELETE ON public.phase2_union_ratings TO service_role;
-- DELETE on both is required for the force_rebuild path (cascade from
-- case_action_union deletion propagates to phase2_union_ratings via FK).
