-- case_consensus — per-case cache of the human-atom clustering result.
--
-- Motivation: clusterEquivalentActions is a non-idempotent LLM call. Calling
-- it once per (case, provider) cell re-rolls the cluster shape for each of
-- the 5 providers on the same case, producing provider-randomised UNSCORABLE
-- outcomes on cases where consensus is borderline. The consensus set is a
-- property of the human atoms only — same input across every provider — so
-- it should be computed once per case and reused.
--
-- This table holds that computed-once result and the second-stage
-- consensus-failure classification (DIVERGENT vs FRAGMENTED vs
-- UNDERSPECIFIED) when no cluster reaches the 0.66 quorum threshold.
--
-- consensus_status values:
--   consensus_found         — at least one cluster reached w_h >= 0.66
--   contested               — n >= 3 annotators, no cluster >= 0.66, second-stage classifier said DIVERGENT
--   fragmented              — n >= 3 annotators, no cluster >= 0.66, second-stage classifier said FRAGMENTED
--   underspecified          — n >= 3 annotators, no cluster >= 0.66, second-stage classifier said UNDERSPECIFIED
--   insufficient_annotators — n < 3 annotators with non-empty atom lists (hard gate; no second-stage call)
--   no_annotations          — humanAnnotations array was empty
--   no_atoms                — annotations present but every annotator's atom list was empty
--   clustering_failed       — clusterEquivalentActions returned {} (LLM/JSON error)

CREATE TABLE IF NOT EXISTS public.case_consensus (
  case_id                    text PRIMARY KEY,
  clusters                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  consensus_candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,
  minority_actions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  n_annotators               integer NOT NULL,
  atom_count                 integer NOT NULL,
  consensus_status           text NOT NULL,
  failure_classifier_label   text,
  failure_classifier_reason  text,
  computed_at                timestamptz NOT NULL DEFAULT now(),
  synthetic                  boolean NOT NULL DEFAULT false,
  CONSTRAINT case_consensus_status_chk CHECK (
    consensus_status IN (
      'consensus_found',
      'contested',
      'fragmented',
      'underspecified',
      'insufficient_annotators',
      'no_annotations',
      'no_atoms',
      'clustering_failed'
    )
  ),
  CONSTRAINT case_consensus_classifier_label_chk CHECK (
    failure_classifier_label IS NULL OR failure_classifier_label IN (
      'DIVERGENT', 'FRAGMENTED', 'UNDERSPECIFIED'
    )
  )
);

CREATE INDEX IF NOT EXISTS case_consensus_synthetic_idx
  ON public.case_consensus (synthetic)
  WHERE synthetic = true;

-- RLS: enable so the anon key cannot read. The Edge Functions hit this table
-- with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS by default. No policies
-- are intentionally declared — service-role-key callers have full access, all
-- other roles have none.
ALTER TABLE public.case_consensus ENABLE ROW LEVEL SECURITY;
