-- judge_ensemble — multi-family presence-judge ensemble.
--
-- MOTIVATION (the score-circularity that this migration engineers away).
--
-- Atom extractor (parse-actions) extracts H_c using anthropic / sonnet-4-6.
-- Presence-judge (checkActionPresent) decides y_h using anthropic / sonnet-4-6.
-- Same family on BOTH sides of the W_c equation: the consensus actions are
-- written in sonnet's distillation idiom, and a sibling sonnet judges whether
-- a candidate model "recommends" them. The pipeline ASSUMED this was
-- score-irrelevant. This migration replaces the assumption with a measurement.
--
-- POST-MIGRATION ARCHITECTURE:
--   - Atom extractor stays anthropic / sonnet-4-6 (the H_c factory, quality-pinned)
--   - Presence-judge becomes a 3-family ENSEMBLE, all disjoint from anthropic:
--       * openai     → gpt-5.5      (reasoning shape)
--       * gemini     → gemini-2.5-pro (gemini shape)
--       * xai        → grok-4.3     (reasoning shape)
--     Each family runs the existing K=5 within-family majority. Ensemble y_h
--     is the majority across families (≥2 of 3 → YES, else NO). The previously
--     dominant anthropic judge is REMOVED from the ensemble entirely — the
--     point is to prove score-invariance ACROSS judge families, not to keep
--     anthropic as a tiebreaker.
--   - Per-decision agreement label captured. The publishable INVARIANCE METRIC
--     is the unanimous_rate over decisions ('unanimous_yes' or 'unanimous_no'),
--     computed via SQL rollup over case_action_y_h_ensemble. Synthetic cases
--     are excluded from publishable numbers (synthetic=true flag).
--
-- CACHE SHAPE (two tables, both keyed by the judge_prompt_version hash so
-- prompt edits auto-invalidate; the ensemble table is additionally keyed by
-- judge_ensemble_id = sha256(sorted-families) so ensemble-composition changes
-- also auto-invalidate):
--
--   1. case_action_y_h (existing, extended)
--      One row per (decision × judge_family). Holds the per-family K=5
--      majority + samples audit trail. Reused for replays and the agreement
--      report. Backfilled rows from the pre-ensemble era are labelled
--      judge_family='anthropic', judge_model='claude-sonnet-4-6'.
--
--   2. case_action_y_h_ensemble (new)
--      One row per (decision × ensemble). Holds the ensemble result +
--      per_family_majorities snapshot + agreement label. This is the
--      SCORING SURFACE — what scoreReasoningAlignment reads. Hit → byte-
--      identical W_c on reruns; miss → fan out to per-family layer, then
--      aggregate, then upsert.
--
-- REPRODUCIBILITY: same (case, response_hash, action, prompt_version,
-- ensemble_id) → same ensemble_y_h forever. The K-sample within-family
-- majority + tie→NO convention + only-cache-valid-results discipline from
-- the original cache are all preserved.

-- ──────────────────────────────────────────────────────────────────────────
-- Table 1: extend case_action_y_h with the judge_family axis
-- ──────────────────────────────────────────────────────────────────────────
--
-- DEFAULTS are LOAD-BEARING for migration safety: both new columns have
-- backwards-compatible defaults so any in-flight pre-ensemble writes (during
-- the deploy window) succeed without explicit judge_family/judge_model in
-- the row body. New code writes explicit values; old code (if any racing the
-- deploy) gets the anthropic/sonnet-4-6 defaults.

ALTER TABLE public.case_action_y_h
  ADD COLUMN IF NOT EXISTS judge_family text NOT NULL DEFAULT 'anthropic',
  ADD COLUMN IF NOT EXISTS judge_model  text NOT NULL DEFAULT 'claude-sonnet-4-6';

-- Replace the UNIQUE constraint to include the new family axis.
-- Pre-existing rows backfilled to judge_family='anthropic' via DEFAULT;
-- the new constraint is a strict SUPERSET of the old key, so every existing
-- row remains uniquely identified under the new shape (no row collisions).
ALTER TABLE public.case_action_y_h
  DROP CONSTRAINT IF EXISTS case_action_y_h_key;

ALTER TABLE public.case_action_y_h
  ADD CONSTRAINT case_action_y_h_key UNIQUE
    (case_id, model_response_hash, consensus_action, judge_prompt_version, judge_family);

-- ──────────────────────────────────────────────────────────────────────────
-- Table 2: new ensemble surface
-- ──────────────────────────────────────────────────────────────────────────
--
-- judge_ensemble_id is sha256(sorted-families CSV) — the same automatic-
-- invalidation pattern as judge_prompt_version. Swap any family in the
-- ensemble (or change the order in the canonical sort) and the id shifts,
-- making every cached ensemble row unreachable until rebuilt. No manual
-- versioning to forget when the ensemble composition is revised.
--
-- agreement values are the four possible outcomes of a 3-family vote with
-- a binary per-family judgment:
--   unanimous_yes  → all 3 said YES
--   unanimous_no   → all 3 said NO
--   split_2yes_1no → 2 YES, 1 NO  (ensemble = YES via majority rule)
--   split_1yes_2no → 1 YES, 2 NO  (ensemble = NO  via majority rule)
-- unanimous=true denormalises the first two for fast SQL rollups (the
-- publishable invariance number is "% of decisions that were unanimous").

CREATE TABLE IF NOT EXISTS public.case_action_y_h_ensemble (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id                  text   NOT NULL,
  model_response_hash      text   NOT NULL,
  consensus_action         text   NOT NULL,
  judge_prompt_version     text   NOT NULL,
  judge_ensemble_id        text   NOT NULL,
  judge_families           text[] NOT NULL,
  per_family_majorities    jsonb  NOT NULL,
  ensemble_y_h             boolean NOT NULL,
  agreement                text   NOT NULL,
  unanimous                boolean NOT NULL,
  judged_at                timestamptz NOT NULL DEFAULT now(),
  synthetic                boolean NOT NULL DEFAULT false,
  CONSTRAINT cay_ens_key UNIQUE
    (case_id, model_response_hash, consensus_action, judge_prompt_version, judge_ensemble_id),
  CONSTRAINT cay_ens_hash_chk     CHECK (model_response_hash  ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cay_ens_prompt_chk   CHECK (judge_prompt_version ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cay_ens_ensemble_chk CHECK (judge_ensemble_id    ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cay_ens_agree_chk    CHECK (agreement IN ('unanimous_yes','unanimous_no','split_2yes_1no','split_1yes_2no')),
  CONSTRAINT cay_ens_unanimous_chk CHECK (
    (unanimous = true  AND agreement IN ('unanimous_yes','unanimous_no')) OR
    (unanimous = false AND agreement IN ('split_2yes_1no','split_1yes_2no'))
  ),
  CONSTRAINT cay_ens_majority_chk CHECK (
    (ensemble_y_h = true  AND agreement IN ('unanimous_yes','split_2yes_1no')) OR
    (ensemble_y_h = false AND agreement IN ('unanimous_no','split_1yes_2no'))
  )
);

-- Lookup index — the composite UNIQUE already covers SELECT by the full
-- 5-tuple. Synthetic partial index lets the publishable-rollup query
-- (`WHERE synthetic = false`) prune efficiently when the bench grows.
CREATE INDEX IF NOT EXISTS case_action_y_h_ensemble_synthetic_idx
  ON public.case_action_y_h_ensemble (synthetic)
  WHERE synthetic = true;

CREATE INDEX IF NOT EXISTS case_action_y_h_ensemble_publishable_idx
  ON public.case_action_y_h_ensemble (judge_prompt_version, judge_ensemble_id, unanimous)
  WHERE synthetic = false;

ALTER TABLE public.case_action_y_h_ensemble ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_action_y_h_ensemble TO service_role;
