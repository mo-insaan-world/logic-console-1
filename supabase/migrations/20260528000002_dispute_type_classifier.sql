-- dispute_type_classifier — per-decision DISPUTE-TYPE labels for the multi-
-- family presence-judge ensemble.
--
-- PURPOSE (descriptive analysis only):
--   For each consensus action being judged, classify what KIND of judgment the
--   presence call hinged on:
--     core_action — does the candidate recommend the action at all
--     qualifier   — same core action but the consensus action carries a
--                   refinement (dose, approach, zone, timing window,
--                   imaging-guidance, coordination requirement) that the
--                   candidate either omits or specifies differently
--     contingency — the action is mentioned only as a backup/conditional/
--                   fallback ("use shunt if >30 min clamp time")
--     intent      — related but different procedure (completion angiogram vs.
--                   diagnostic angiogram; primary repair vs. interposition)
--
-- WHY THIS TABLE IS PHYSICALLY SEPARATE FROM case_action_y_h_ensemble:
--   The score (M_c, A_c, W_c, S_c) MUST NEVER depend on dispute_type. Keeping
--   the analysis data in its own table makes that invariant grep-checkable —
--   scoring code reads case_action_y_h_ensemble; analysis code reads
--   case_action_dispute_type. The two never join in the scoring code path.
--   If this table is dropped or its rows go missing, scoring still works
--   bit-identically.
--
-- KEY DESIGN:
--   judge_prompt_version + judge_ensemble_id key into case_action_y_h_ensemble
--   1:1 — the same decision identified by the same hashes. Adding
--   classifier_prompt_version to the UNIQUE means prompt evolution preserves
--   prior labels (rollups filter on the current hash; old runs stay
--   queryable for audit). Same auto-invalidation pattern as the existing
--   judge_prompt_version + judge_ensemble_id surfaces.
--
-- KNOWN ANALYSIS LIMITATION (encoded in this comment so it travels with the
-- schema): the classifier family (gemini-2.5-pro) is one of the three
-- ensemble voters. The classifier is therefore reading its own vote when
-- labelling a dispute. This does NOT affect scoring (the score-path
-- guarantee in score-responses/index.ts holds), but it is a limitation of
-- the dispute-type labels as an INDEPENDENT arbiter — they should be
-- reported as a descriptive aid, not as ground truth about why families
-- disagreed. To get an independent arbiter, swap DISPUTE_CLASSIFIER_FAMILY
-- in score-responses/index.ts to a family OUTSIDE the ensemble (no such
-- family currently exists in the wired set; would require adding one).

CREATE TABLE IF NOT EXISTS public.case_action_dispute_type (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id                     text  NOT NULL,
  model_response_hash         text  NOT NULL,
  consensus_action            text  NOT NULL,
  judge_prompt_version        text  NOT NULL,
  judge_ensemble_id           text  NOT NULL,
  dispute_type                text  NOT NULL,
  classifier_family           text  NOT NULL,
  classifier_model            text  NOT NULL,
  classifier_prompt_version   text  NOT NULL,
  classifier_rationale        text,
  classified_at               timestamptz NOT NULL DEFAULT now(),
  synthetic                   boolean NOT NULL DEFAULT false,
  CONSTRAINT cad_key UNIQUE
    (case_id, model_response_hash, consensus_action, judge_prompt_version, judge_ensemble_id, classifier_prompt_version),
  CONSTRAINT cad_type_chk        CHECK (dispute_type IN ('core_action','qualifier','contingency','intent')),
  CONSTRAINT cad_hash_chk        CHECK (model_response_hash       ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cad_prompt_chk      CHECK (judge_prompt_version      ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cad_ens_chk         CHECK (judge_ensemble_id         ~ '^[0-9a-f]{64}$'),
  CONSTRAINT cad_classifier_chk  CHECK (classifier_prompt_version ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS case_action_dispute_type_publishable_idx
  ON public.case_action_dispute_type (judge_prompt_version, judge_ensemble_id, classifier_prompt_version, dispute_type)
  WHERE synthetic = false;

CREATE INDEX IF NOT EXISTS case_action_dispute_type_synthetic_idx
  ON public.case_action_dispute_type (synthetic)
  WHERE synthetic = true;

ALTER TABLE public.case_action_dispute_type ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.case_action_dispute_type TO service_role;
